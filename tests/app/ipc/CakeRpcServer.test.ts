import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Scope, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import { describe, expect } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import * as cakeChatLocations from "../../../src/domain/cake-chats/cakeChatLocations";
import { makeCakeRpcServerLive } from "../../../src/ipc/server/CakeRpcServer";
import {
  correlationIdHeader,
  rendererConnectionHeader,
} from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import { ClientWorkspacesLive } from "../../../src/services/clients/ClientWorkspacesLive";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { unusedEndpointServices } from "./rpc-endpoint-test-backend";

const endpoint = makeCakeRpcServerLive("/home/test", {
  agentDirectory: "/agent",
  location: cakeChatLocations.make({
    homeDirectory: "/home/test",
    sessionDirectory: "/chat",
    resolvedSessionDirectory: "/chat-resolved",
  }),
});

const makeBackend = Effect.fn("RpcEndpoint.test.makeBackend")(function* (failHome = false) {
  const stats = { acquisitions: 0, releases: 0, saves: 0, allowed: [] as string[] };
  const storage = Layer.effect(
    ApplicationStorage,
    Effect.gen(function* () {
      stats.acquisitions += 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stats.releases += 1;
        }),
      );
      return ApplicationStorage.of({
        load: () => Effect.succeed({ state: defaultApplicationState(), source: "missing" }),
        save: () =>
          Effect.sync(() => {
            stats.saves += 1;
          }),
      });
    }),
  );
  const streamReleases = yield* Queue.unbounded<number>();
  const observedClientEvents = Layer.effect(
    ClientEvents,
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      return ClientEvents.of({
        ...events,
        application: (connectionId) =>
          events
            .application(connectionId)
            .pipe(Stream.ensuring(Queue.offer(streamReleases, connectionId))),
      });
    }),
  ).pipe(Layer.provide(ClientEventsLive));
  const backendScope = yield* Scope.fork(yield* Effect.scope);
  const context = yield* Layer.buildWithScope(
    Layer.mergeAll(
      ApplicationState.layer.pipe(Layer.provide(storage)),
      observedClientEvents,
      ClientWorkspacesLive,
      unusedEndpointServices,
      Layer.mock(ProjectAccess, {
        allow: (path) =>
          failHome
            ? Effect.die("controlled request defect")
            : Effect.sync(() => {
                stats.allowed.push(path);
              }),
      }),
    ),
    backendScope,
  );
  return { context, stats, streamReleases, close: () => Scope.close(backendScope, Exit.void) };
});

type Backend = Effect.Success<ReturnType<typeof makeBackend>>;

/** A controlled transport only: dispatch, middleware, handlers, encoding and cancellation are real. */
const openEndpoint = Effect.fn("RpcEndpoint.test.openEndpoint")(function* (
  backend: Backend,
  connectionId: number,
) {
  const incoming = yield* Queue.unbounded<FromClientEncoded>();
  const responses = yield* Queue.unbounded<FromServerEncoded>();
  const disconnects = yield* Queue.unbounded<number>();
  const ready = yield* Deferred.make<void>();
  const scope = yield* Scope.fork(yield* Effect.scope);
  const lifecycle = { released: false };
  const protocol = Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          lifecycle.released = true;
        }),
      );
      return RpcServer.Protocol.of({
        run: (writeRequest) =>
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(
              Effect.forever(
                Queue.take(incoming).pipe(
                  Effect.flatMap((message) => writeRequest(connectionId, message)),
                ),
              ),
            ),
          ),
        disconnects,
        send: (recipient, response) =>
          Effect.gen(function* () {
            expect(recipient).toBe(connectionId);
            yield* Queue.offer(responses, response);
          }),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([connectionId])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: false,
      });
    }),
  );
  // Supply values acquired in the backend Scope, never the backend Layer. Independent endpoint
  // builds therefore cannot acquire or finalize application/runtime/storage authorities.
  yield* Layer.buildWithScope(endpoint.pipe(Layer.provide(protocol)), scope).pipe(
    Effect.provideContext(backend.context),
  );
  yield* Deferred.await(ready);
  let requestId = 0;
  const request = Effect.fn("RpcEndpoint.test.request")(function* (
    tag: string,
    payload: unknown = null,
  ) {
    const id = String(++requestId);
    yield* Queue.offer(incoming, {
      _tag: "Request",
      id,
      tag,
      payload,
      headers: [
        [rendererConnectionHeader, String(connectionId)],
        [correlationIdHeader, `${connectionId}:${id}`],
      ],
    });
    return id;
  });
  return {
    request,
    responses,
    lifecycle,
    write: (message: FromClientEncoded) => Queue.offer(incoming, message),
    disconnect: () => Queue.offer(disconnects, connectionId),
    close: () => Scope.close(scope, Exit.void),
  };
});

const notification = {
  type: "notification" as const,
  tone: "info" as const,
  title: "Shared backend",
  message: "one authority",
};
const readyEvent = { type: "renderer-events-ready", channel: "application" };

const observeEvents = Effect.fn("RpcEndpoint.test.observeEvents")(function* (
  endpoint: Effect.Success<ReturnType<typeof openEndpoint>>,
) {
  const id = yield* endpoint.request("application.observeEvents");
  expect(yield* Queue.take(endpoint.responses)).toEqual({
    _tag: "Chunk",
    requestId: id,
    values: [readyEvent],
  });
  yield* endpoint.write({ _tag: "Ack", requestId: id });
  return id;
});

describe("Cake RPC endpoint", () => {
  it.effect("rpc_endpoint_uses_host_supplied_protocol", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend();
      const host = yield* openEndpoint(backend, 7);
      const id = yield* host.request("application.getHomeDirectory");
      expect(yield* Queue.take(host.responses)).toEqual({
        _tag: "Exit",
        requestId: id,
        exit: { _tag: "Success", value: "/home/test" },
      });
      expect(backend.stats.allowed).toEqual(["/home/test"]);
      const streamId = yield* observeEvents(host);
      expect(Context.get(backend.context, ClientEvents).sendTo(7, notification)).toBe(true);
      expect(yield* Queue.take(host.responses)).toEqual({
        _tag: "Chunk",
        requestId: streamId,
        values: [notification],
      });
    }),
  );

  it.effect("two_endpoint_scopes_share_backend_authority", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend();
      const first = yield* openEndpoint(backend, 11);
      const second = yield* openEndpoint(backend, 22);
      const firstStream = yield* observeEvents(first);
      const secondStream = yield* observeEvents(second);
      Context.get(backend.context, ClientEvents).broadcast(notification);
      expect(yield* Queue.take(first.responses)).toEqual({
        _tag: "Chunk",
        requestId: firstStream,
        values: [notification],
      });
      expect(yield* Queue.take(second.responses)).toEqual({
        _tag: "Chunk",
        requestId: secondStream,
        values: [notification],
      });
      const mutationId = yield* first.request("application.setSessionPluginSharedState", {
        sessionId: "session-1",
        key: "shared",
        value: "first endpoint",
      });
      expect(yield* Queue.take(first.responses)).toMatchObject({
        _tag: "Exit",
        requestId: mutationId,
        exit: { _tag: "Success" },
      });
      const readId = yield* second.request("application.getState");
      expect(yield* Queue.take(second.responses)).toMatchObject({
        _tag: "Exit",
        requestId: readId,
        exit: {
          _tag: "Success",
          value: {
            sessionPluginSharedState: [
              { sessionId: "session-1", key: "shared", value: "first endpoint" },
            ],
          },
        },
      });
      expect(backend.stats).toMatchObject({ acquisitions: 1, releases: 0, saves: 1 });
    }),
  );

  it.effect("closing_endpoint_preserves_backend_and_other_endpoint", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend();
      const first = yield* openEndpoint(backend, 11);
      const second = yield* openEndpoint(backend, 22);
      yield* observeEvents(first);
      const secondStream = yield* observeEvents(second);
      yield* first.close();
      expect(first.lifecycle.released).toBe(true);
      expect(second.lifecycle.released).toBe(false);
      const events = Context.get(backend.context, ClientEvents);
      expect(events.sendTo(11, notification)).toBe(false);
      expect(events.sendTo(22, notification)).toBe(true);
      expect(yield* Queue.take(second.responses)).toEqual({
        _tag: "Chunk",
        requestId: secondStream,
        values: [notification],
      });
      const id = yield* second.request("application.getHomeDirectory");
      expect(yield* Queue.take(second.responses)).toMatchObject({
        _tag: "Exit",
        requestId: id,
        exit: { _tag: "Success", value: "/home/test" },
      });
      yield* second.close();
      expect(backend.stats.releases).toBe(0);
      expect(yield* Context.get(backend.context, ApplicationState).current()).toEqual(
        defaultApplicationState(),
      );
      yield* backend.close();
      expect(backend.stats).toMatchObject({ acquisitions: 1, releases: 1 });
    }),
  );

  it.effect("request interruption and disconnect release only their stream subscriptions", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend();
      const first = yield* openEndpoint(backend, 11);
      const second = yield* openEndpoint(backend, 22);
      const firstStream = yield* observeEvents(first);
      const secondStream = yield* observeEvents(second);
      yield* first.write({ _tag: "Interrupt", requestId: firstStream });
      expect(yield* Queue.take(first.responses)).toMatchObject({
        _tag: "Exit",
        requestId: firstStream,
        exit: { _tag: "Failure" },
      });
      const events = Context.get(backend.context, ClientEvents);
      expect(events.sendTo(11, notification)).toBe(false);
      expect(events.sendTo(22, notification)).toBe(true);
      expect(yield* Queue.take(second.responses)).toEqual({
        _tag: "Chunk",
        requestId: secondStream,
        values: [notification],
      });
      expect(yield* Queue.take(backend.streamReleases)).toBe(11);
      yield* second.disconnect();
      // Disconnected transports cannot receive a terminal response. Wait on actual stream cleanup.
      expect(yield* Queue.take(backend.streamReleases)).toBe(22);
      expect(events.sendTo(22, notification)).toBe(false);
      expect(backend.stats.releases).toBe(0);
    }),
  );

  it.effect("handler defects remain request-correlated and leave other streams alive", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend(true);
      const host = yield* openEndpoint(backend, 7);
      const streamId = yield* observeEvents(host);
      const failedId = yield* host.request("application.getHomeDirectory");
      expect(yield* Queue.take(host.responses)).toMatchObject({
        _tag: "Exit",
        requestId: failedId,
        exit: { _tag: "Failure" },
      });
      expect(Context.get(backend.context, ClientEvents).sendTo(7, notification)).toBe(true);
      expect(yield* Queue.take(host.responses)).toEqual({
        _tag: "Chunk",
        requestId: streamId,
        values: [notification],
      });
    }),
  );
});
