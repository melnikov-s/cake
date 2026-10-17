import { it } from "@effect/vitest";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Scope, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import { describe, expect } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import * as cakeChatLocations from "../../../src/domain/cake-chats/cakeChatLocations";
import { makeCakeRpcServerLive } from "../../../src/ipc/server/CakeRpcServer";
import { makeBackendRpcServerLive } from "../../../src/ipc/server/BackendRpcServer";
import { BackendRpc } from "../../../src/ipc/protocol/BackendRpc";
import { CakeRpc, DesktopRpc } from "../../../src/ipc/protocol/CakeRpc";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";
import { workspaceHandlers } from "../../../src/ipc/server/WorkspaceHandlers";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
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
import { ElevenLabsSpeech } from "../../../src/services/speech/ElevenLabsSpeech";
import { PocketTts } from "../../../src/services/speech/PocketTts";
import { pocketTtsState } from "../../helpers/speech-output";
import { WidgetPackages } from "../../../src/services/widgets/WidgetPackages";

const configuration = {
  agentDirectory: "/agent",
  location: cakeChatLocations.make({
    homeDirectory: "/home/test",
    sessionDirectory: "/chat",
  }),
};
const endpoint = makeCakeRpcServerLive("/home/test", configuration);
const backendEndpoint = makeBackendRpcServerLive("/home/test", configuration);

const makeBackend = Effect.fn("RpcEndpoint.test.makeBackend")(function* (
  failHome = false,
  failSave = false,
) {
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
          failSave
            ? Effect.fail(new ApplicationWriteError({ stage: "write", message: "save failed" }))
            : Effect.sync(() => {
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
      WorkflowTestLive,
      ApplicationState.layer.pipe(Layer.provide(storage)),
      observedClientEvents,
      ClientWorkspacesLive,
      unusedEndpointServices,
      Layer.succeed(
        PocketTts,
        PocketTts.of({
          observeState: () => Stream.make(pocketTtsState()),
          getState: () => Effect.succeed(pocketTtsState()),
          select: () => Effect.void,
          setSpeed: () => Effect.void,
          install: () => Effect.void,
          remove: () => Effect.void,
          synthesize: () => Stream.empty,
        }),
      ),
      Layer.succeed(
        ElevenLabsSpeech,
        ElevenLabsSpeech.of({
          observeSettings: () =>
            Stream.make({
              keyConfigured: false,
              modelId: "eleven_flash_v2_5",
              speed: 1,
              voices: [],
            }),
          setApiKey: () => Effect.void,
          setVoice: () => Effect.void,
          setSpeed: () => Effect.void,
          listVoices: () => Effect.succeed([]),
          synthesize: () => Stream.empty,
        }),
      ),
      Layer.mock(ProjectAccess, {
        isAllowed: () => Effect.succeed(false),
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
  server: typeof endpoint | typeof backendEndpoint = endpoint,
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
  yield* Layer.buildWithScope(server.pipe(Layer.provide(protocol)), scope).pipe(
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
  it("local and network backend operation parity; desktop-only groups absent remotely", () => {
    expect([...CakeRpc.requests.keys()].sort()).toEqual(
      [...BackendRpc.requests.keys(), ...DesktopRpc.requests.keys()].sort(),
    );
    for (const [tag, rpc] of BackendRpc.requests) {
      // Both hosts use the same schemas and middleware, not reconstructed copies.
      expect(CakeRpc.requests.get(tag)).toBe(rpc);
    }
    for (const tag of DesktopRpc.requests.keys()) {
      expect(BackendRpc.requests.has(tag)).toBe(false);
    }
  });

  it.effect(
    "local and network endpoints share the acquired backend without extra acquisition",
    () =>
      Effect.gen(function* () {
        const backend = yield* makeBackend();
        const local = yield* openEndpoint(backend, 11);
        const network = yield* openEndpoint(backend, 22, backendEndpoint);
        const id = yield* local.request("workspaces.set-global-custom-instructions", {
          instructions: "  Shared settings  ",
        });
        expect(yield* Queue.take(local.responses)).toMatchObject({
          requestId: id,
          exit: {
            _tag: "Success",
            value: { state: { globalCustomInstructions: "Shared settings" } },
          },
        });
        const readId = yield* network.request("application.getState");
        expect(yield* Queue.take(network.responses)).toMatchObject({
          requestId: readId,
          exit: { _tag: "Success", value: { globalCustomInstructions: "Shared settings" } },
        });
        yield* local.close();
        yield* network.close();
        expect(backend.stats).toMatchObject({ acquisitions: 1, releases: 0, saves: 1 });
        yield* backend.close();
        expect(backend.stats.releases).toBe(1);
      }),
  );

  it.effect("direct settings handlers need only their application owner, not a connection", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend();
      // Providing only this tag makes the lack of a connection dependency a compile-time check.
      const result = yield* workspaceHandlers["workspaces.set-global-custom-instructions"]({
        instructions: "  Direct  ",
      }).pipe(
        Effect.provideService(ApplicationState, Context.get(backend.context, ApplicationState)),
      );
      expect(result.state.globalCustomInstructions).toBe("Direct");
    }),
  );

  for (const [hostName, server] of [
    ["local", endpoint],
    ["network", backendEndpoint],
  ] as const) {
    it.effect(
      `${hostName} direct settings routes preserve payloads and project authorization`,
      () =>
        Effect.gen(function* () {
          const backend = yield* makeBackend();
          const host = yield* openEndpoint(backend, 7, server);
          const preferences = { ...defaultCakeChatPreferences(), instructions: "Chat guidance" };
          const model = {
            provider: "fixture",
            modelId: "utility",
            thinkingLevel: "high",
          };
          const cases = [
            { tag: "set-utility-model", payload: { model }, expected: { utilityModel: model } },
            {
              tag: "set-cake-chat-preferences",
              payload: { preferences },
              expected: { cakeChatPreferences: preferences },
            },
            {
              tag: "set-cake-prompts",
              payload: { prompts: { worktreeCommit: "Custom commit" } },
              expected: { cakePrompts: { worktreeCommit: "Custom commit" } },
            },
            {
              tag: "set-global-custom-instructions",
              payload: { instructions: "  Personal guidance  " },
              expected: { globalCustomInstructions: "Personal guidance" },
            },
          ];
          for (const { tag, payload, expected } of cases) {
            const id = yield* host.request(`workspaces.${tag}`, payload);
            expect(yield* Queue.take(host.responses)).toMatchObject({
              requestId: id,
              exit: { _tag: "Success", value: { state: expected } },
            });
          }
          const cleared = yield* host.request("workspaces.set-utility-model", {});
          expect(yield* Queue.take(host.responses)).toMatchObject({
            requestId: cleared,
            exit: { _tag: "Success" },
          });
          expect(Context.get(backend.context, ApplicationState).snapshot()).not.toHaveProperty(
            "utilityModel",
          );
          const denied = yield* host.request("workspaces.set-project-settings", {
            path: "/unapproved",
            settings: defaultProjectSettings(),
          });
          expect(yield* Queue.take(host.responses)).toMatchObject({
            requestId: denied,
            exit: {
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: {
                    _tag: "ProjectError",
                    operation: "authorizeWorkingDirectory",
                    message: "Project path was not selected by the user",
                  },
                },
              ],
            },
          });
          expect(backend.stats).toMatchObject({ acquisitions: 1, saves: 5 });
        }),
    );

    it.effect(`${hostName} settings routes retain middleware identity and payload validation`, () =>
      Effect.gen(function* () {
        const backend = yield* makeBackend();
        const host = yield* openEndpoint(backend, 7, server);
        yield* host.write({
          _tag: "Request",
          id: "untrusted",
          tag: "workspaces.set-global-custom-instructions",
          payload: { instructions: "Not authorized by the transport" },
          headers: [],
        });
        expect(yield* Queue.take(host.responses)).toMatchObject({
          requestId: "untrusted",
          exit: { _tag: "Failure" },
        });
        const malformed = yield* host.request("workspaces.set-global-custom-instructions", {
          instructions: 42,
        });
        expect(yield* Queue.take(host.responses)).toMatchObject({
          requestId: malformed,
          exit: { _tag: "Failure" },
        });
        expect(backend.stats.saves).toBe(0);
        expect(Context.get(backend.context, ApplicationState).snapshot()).toEqual(
          defaultApplicationState(),
        );
      }),
    );

    it.effect(`${hostName} direct settings routes preserve typed persistence failures`, () =>
      Effect.gen(function* () {
        const backend = yield* makeBackend(false, true);
        const host = yield* openEndpoint(backend, 7, server);
        const cases = [
          { tag: "set-utility-model", operation: "setUtilityModel", payload: {} },
          {
            tag: "set-cake-chat-preferences",
            operation: "setCakeChatPreferences",
            payload: { preferences: defaultCakeChatPreferences() },
          },
          { tag: "set-cake-prompts", operation: "setCakePrompts", payload: { prompts: {} } },
          {
            tag: "set-global-custom-instructions",
            operation: "setGlobalCustomInstructions",
            payload: { instructions: "Never saved" },
          },
        ];
        for (const { tag, operation, payload } of cases) {
          const id = yield* host.request(`workspaces.${tag}`, payload);
          expect(yield* Queue.take(host.responses)).toMatchObject({
            requestId: id,
            exit: {
              _tag: "Failure",
              cause: [
                {
                  _tag: "Fail",
                  error: { _tag: "ProjectError", operation, message: "save failed" },
                },
              ],
            },
          });
          expect(Context.get(backend.context, ApplicationState).snapshot()).toEqual(
            defaultApplicationState(),
          );
        }
      }),
    );
  }

  it.effect("widget package RPCs validate approval and invoke the backend package authority", () =>
    Effect.gen(function* () {
      const backend = yield* makeBackend();
      const calls: string[] = [];
      const snapshot = {
        directory: "/backend/widget-packages",
        packages: [{ name: "d3", version: "7.9.0" }],
      };
      const packages = WidgetPackages.of({
        directory: snapshot.directory,
        list: () => Effect.succeed(snapshot),
        install: (specifier) =>
          Effect.sync(() => {
            calls.push(specifier);
            return snapshot;
          }),
        remove: (name) =>
          Effect.sync(() => {
            calls.push(name);
            return { ...snapshot, packages: [] };
          }),
      });
      const host = yield* openEndpoint(
        { ...backend, context: Context.add(backend.context, WidgetPackages, packages) },
        7,
      );
      const rejected = yield* host.request("widgetPackages.install", {
        specifier: "d3",
        userApproved: false,
      });
      expect(yield* Queue.take(host.responses)).toMatchObject({
        requestId: rejected,
        exit: { _tag: "Failure" },
      });
      expect(calls).toEqual([]);
      const listed = yield* host.request("widgetPackages.list", {});
      expect(yield* Queue.take(host.responses)).toMatchObject({
        requestId: listed,
        exit: { _tag: "Success", value: snapshot },
      });
      const installed = yield* host.request("widgetPackages.install", {
        specifier: "d3@7",
        userApproved: true,
      });
      expect(yield* Queue.take(host.responses)).toMatchObject({
        requestId: installed,
        exit: { _tag: "Success", value: snapshot },
      });
      const removed = yield* host.request("widgetPackages.remove", { name: "d3" });
      expect(yield* Queue.take(host.responses)).toMatchObject({
        requestId: removed,
        exit: { _tag: "Success", value: { ...snapshot, packages: [] } },
      });
      expect(calls).toEqual(["d3@7", "d3"]);
    }),
  );
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
