import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { CakeEvent } from "../../src/ipc/cake-rpc-contract";
import {
  rendererConnectionHeader,
  correlationIdHeader,
} from "../../src/ipc/protocol/RendererConnectionMiddleware";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import { expect, vi } from "vitest";
import { BackendRpc } from "../../src/ipc/protocol/BackendRpc";
import { makeBackendRpcServerLive } from "../../src/ipc/server/BackendRpcServer";
import { ElectronRpcServerProtocolLive } from "../../src/ipc/transport/ElectronRpcServerProtocol";
import { makeElectronRpcClientProtocol } from "../../src/ipc/transport/ElectronRpcClientProtocol";
import { rpcRequestChannel, rpcResponseChannel } from "../../src/ipc/transport/ElectronRpcChannels";
import { makeDesktopSharingLive } from "../../src/services/electron/DesktopSharingLive";
import { DesktopSharing } from "../../src/services/electron/DesktopSharing";
import { ClientConnections } from "../../src/services/clients/ClientConnections";
import { ClientWorkspaces } from "../../src/services/clients/ClientWorkspaces";
import { RendererRequestCoordinator } from "../../src/services/renderer-requests/RendererRequestCoordinator";
import { ClientEvents } from "../../src/services/clients/ClientEvents";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { connectClient } from "./fixtures/network-client";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { cakeBuildId } from "../../src/ipc/protocol/BackendConnectionRpc";

const native = vi.hoisted(() => ({
  emitter: undefined as EventEmitter | undefined,
  sender: undefined as
    | (EventEmitter & {
        id: number;
        isDestroyed(): boolean;
        send(channel: string, input: unknown): void;
      })
    | undefined,
}));
vi.mock("electron", () => ({
  ipcMain: {
    on: (...args: Parameters<EventEmitter["on"]>) => native.emitter?.on(...args),
    removeListener: (...args: Parameters<EventEmitter["removeListener"]>) =>
      native.emitter?.removeListener(...args),
  },
  webContents: { fromId: (id: number) => (id === native.sender?.id ? native.sender : undefined) },
}));
const configuration = {
  homeDirectory: "/home/test",
  cakeChat: {
    agentDirectory: "/agent",
    location: cakeChatLocations.make({
      homeDirectory: "/home/test",
      sessionDirectory: "/chat",
      resolvedSessionDirectory: "/resolved",
    }),
  },
};

const setup = Effect.fn("DesktopSharingTest.setup")(function* () {
  const assets = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "cake-sharing-assets-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  yield* Effect.promise(() => mkdir(join(assets, "assets")));
  yield* Effect.promise(() =>
    writeFile(join(assets, "index.html"), "<!doctype html><title>Cake</title>"),
  );
  const backend = yield* makeNetworkTestBackend();
  const hostScope = yield* Scope.fork(yield* Effect.scope);
  const host = yield* Layer.buildWithScope(
    makeDesktopSharingLive(configuration, assets),
    hostScope,
  ).pipe(Effect.provideContext(backend.context));
  const sharing = Context.get(host, DesktopSharing);
  native.emitter = new EventEmitter();
  const responses = new EventEmitter();
  native.sender = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, input: unknown) => {
      responses.emit(channel, input);
    },
  });
  yield* Layer.build(
    makeBackendRpcServerLive(configuration.homeDirectory, configuration.cakeChat).pipe(
      Layer.provide(ElectronRpcServerProtocolLive),
    ),
  ).pipe(Effect.provideContext(backend.context));
  const localProtocol = yield* Layer.build(
    makeElectronRpcClientProtocol({
      send: (input) => {
        native.emitter?.emit(rpcRequestChannel, { sender: native.sender }, input);
      },
      subscribe: (listener) => {
        responses.on(rpcResponseChannel, listener);
        return () => {
          responses.removeListener(rpcResponseChannel, listener);
        };
      },
    }),
  );
  const local = yield* RpcClient.make(BackendRpc).pipe(Effect.provideContext(localProtocol));
  const remote = Effect.fn("DesktopSharingTest.remote")(function* () {
    const state = yield* sharing.configure({ enabled: true, bind: "127.0.0.1", port: 0 });
    assert.ok(state.url);
    assert.ok(state.editorPort);
    expect(state.editorPort).not.toBe(state.port);
    return yield* connectClient(state.url.replace("http:", "ws:") + "rpc", state.url.slice(0, -1));
  });
  return { backend, sharing, local, remote, closeHost: () => Scope.close(hostScope, Exit.void) };
});

it.live(
  "enable_desktop_serving_during_active_turn; disable_preserves_local_work_and_reenable",
  () =>
    Effect.gen(function* () {
      const { backend, sharing, local, remote, closeHost } = yield* setup();
      const sessionId = "00000000-0000-4000-8000-000000000001";
      const target = { _tag: "ProjectSession" as const, sessionId, workingDirectory: "/project" };
      yield* local["projectSessions.start"]({
        sessionId,
        workingDirectory: "/project",
        text: "desktop work",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      expect(yield* Queue.take(backend.started)).toBe("desktop work");
      expect(backend.stats.acquisitions).toBe(1);
      const a = yield* remote();
      yield* a.client["projectSessions.open"](target);
      const first = yield* a.client["conversations.observe"](target).pipe(Stream.runHead);
      assert.equal(first._tag, "Some");
      expect(first.value).toMatchObject({ _tag: "Snapshot", snapshot: { streaming: true } });
      expect(backend.stats.acquisitions).toBe(1);
      expect(sharing.keepsProcessAlive()).toBe(true);
      yield* sharing.configure({ enabled: false, bind: "127.0.0.1", port: 0 });
      expect(sharing.keepsProcessAlive()).toBe(false);
      expect(backend.stats.aborted).toBe(0);
      expect(backend.stats.releases).toBe(0);
      expect(yield* local["models.list"]()).toEqual([]);
      yield* Deferred.succeed(backend.finish, undefined);
      yield* Queue.take(backend.settled);
      const b = yield* remote();
      const next = yield* b.client["conversations.observe"](target).pipe(Stream.runHead);
      assert.equal(next._tag, "Some");
      expect(next.value).toMatchObject({
        snapshot: { streaming: false, parts: [{ text: "Completed while disconnected" }] },
      });
      expect(backend.stats.turns).toBe(1);
      yield* closeHost();
      expect(backend.stats.backendClosed).toBe(false);
      expect(yield* local["models.list"]()).toEqual([]);
    }).pipe(Effect.scoped),
);

it.live(
  "session device control follows deliberate desktop activation, not input provenance or observation",
  () =>
    Effect.gen(function* () {
      const { backend, local, remote } = yield* setup();
      const sessionId = "00000000-0000-4000-8000-000000000001";
      const target = { _tag: "ProjectSession" as const, sessionId, workingDirectory: "/project" };
      const browser = yield* remote();
      const desktop = yield* remote();
      yield* desktop.client["backendConnection.connect"]({ buildId: cakeBuildId });
      const localEvents = yield* Queue.unbounded<CakeEvent>();
      const remoteEvents = yield* Queue.unbounded<CakeEvent>();
      yield* local["application.observeEvents"]().pipe(
        Stream.runForEach((event) => Queue.offer(localEvents, event)),
        Effect.forkScoped,
      );
      yield* desktop.client["application.observeEvents"]().pipe(
        Stream.runForEach((event) => Queue.offer(remoteEvents, event)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(localEvents)).type).toBe("renderer-events-ready");
      expect((yield* Queue.take(remoteEvents)).type).toBe("renderer-events-ready");
      yield* local["projectSessions.start"]({
        sessionId,
        workingDirectory: "/project",
        text: "first input",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      expect(yield* Queue.take(backend.started)).toBe("first input");
      yield* desktop.client["conversations.observe"](target).pipe(Stream.runHead);
      const failedOpen = yield* desktop.client["projectSessions.open"]({
        ...target,
        workingDirectory: "/nonexistent-project",
      }).pipe(Effect.flip);
      expect(failedOpen.message).toContain("could not find Project Session");
      yield* browser.client["projectSessions.open"](target);
      yield* browser.client["sessionChats.prompt"]({
        sessionId,
        text: "browser follow-up",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      expect(yield* Queue.take(backend.started)).toBe("browser follow-up");
      const requests = Context.get(backend.context, RendererRequestCoordinator);
      const invocation = {
        _tag: "InvokeAppControl" as const,
        command: "session.rename",
        input: { name: "test" },
      };
      const first = yield* requests
        .requestProjectControl(sessionId, invocation, new AbortController().signal)
        .pipe(Effect.forkScoped);
      const firstEvent = yield* Queue.take(localEvents);
      assert.equal(firstEvent.type, "project-session-control-requested");
      expect(firstEvent.sessionId).toBe(sessionId);
      yield* desktop.client["projectSessions.open"](target);
      const wrong = yield* desktop.client["projectSessions.respondControl"]({
        sessionId,
        controlRequestId: firstEvent.controlRequestId,
        result: { ok: true },
      }).pipe(Effect.flip);
      expect(wrong.message).toContain("wrong renderer connection");
      yield* local["projectSessions.respondControl"]({
        sessionId,
        controlRequestId: firstEvent.controlRequestId,
        result: { ok: true },
      });
      expect(yield* Fiber.join(first)).toEqual({ ok: true });
      const second = yield* requests
        .requestProjectControl(sessionId, invocation, new AbortController().signal)
        .pipe(Effect.forkScoped);
      const secondEvent = yield* Queue.take(remoteEvents);
      assert.equal(secondEvent.type, "project-session-control-requested");
      yield* desktop.close();
      expect(yield* Fiber.join(second)).toMatchObject({ ok: false });
      const unavailable = yield* requests
        .requestProjectControl(sessionId, invocation, new AbortController().signal)
        .pipe(Effect.flip);
      expect(unavailable.message).toContain("No eligible desktop");
      expect(backend.stats.aborted).toBe(0);
      yield* Deferred.succeed(backend.finish, undefined);
      yield* Queue.take(backend.settled);
      const a = yield* local["conversations.observe"](target).pipe(Stream.runHead);
      const b = yield* browser.client["conversations.observe"](target).pipe(Stream.runHead);
      assert.equal(a._tag, "Some");
      assert.equal(b._tag, "Some");
      expect(a.value).toMatchObject({
        snapshot: { parts: [{ text: "Completed while disconnected" }] },
      });
      expect(b.value).toMatchObject({
        snapshot: { parts: [{ text: "Completed while disconnected" }] },
      });
      expect(backend.stats.aborted).toBe(0);
    }).pipe(Effect.scoped),
);

it.live("passive Cake Chat control observation does not designate another desktop", () =>
  Effect.gen(function* () {
    const { backend, local, remote } = yield* setup();
    const remoteDesktop = yield* remote();
    yield* remoteDesktop.client["backendConnection.connect"]({ buildId: cakeBuildId });
    const localId = (yield* Effect.gen(function* () {
      yield* local["application.getHomeDirectory"]();
      return yield* Queue.take(backend.metadata);
    })).connectionId;
    const requests = Context.get(backend.context, RendererRequestCoordinator);
    const target = { sessionId: "00000000-0000-4000-8000-000000000019", tools: [] };
    yield* requests.bind({ _tag: "CakeChatSession", sessionId: target.sessionId }, localId);
    const seen = yield* Queue.unbounded<{ connection: "local" | "remote"; requestId: string }>();
    const ready = yield* Queue.unbounded<"local" | "remote">();
    const observe = (connection: "local" | "remote", client: typeof local) =>
      client["cakeChats.observeControls"](target).pipe(
        Stream.runForEach((snapshot) =>
          Effect.gen(function* () {
            yield* Queue.offer(ready, connection);
            yield* Effect.forEach(snapshot.requests, (request) =>
              Queue.offer(seen, { connection, requestId: request.controlRequestId }),
            );
          }),
        ),
        Effect.forkScoped,
      );
    yield* observe("local", local);
    expect(yield* Queue.take(ready)).toBe("local");
    yield* observe("remote", remoteDesktop.client);
    expect(yield* Queue.take(ready)).toBe("remote");
    const pending = yield* requests
      .requestCakeChatControl(
        target.sessionId,
        { name: "projects.open", arguments: {} },
        new AbortController().signal,
      )
      .pipe(Effect.forkScoped);
    const delivery = yield* Queue.take(seen);
    expect(delivery.connection).toBe("local");
    const wrong = yield* remoteDesktop.client["cakeChats.respondControl"]({
      controlRequestId: delivery.requestId,
      result: { ok: true },
    }).pipe(Effect.flip);
    expect(wrong.message).toContain("wrong renderer connection");
    yield* local["cakeChats.respondControl"]({
      controlRequestId: delivery.requestId,
      result: { ok: true },
    });
    expect(yield* Fiber.join(pending)).toEqual({ ok: true });
  }).pipe(Effect.scoped),
);

it.live(
  "ipc_and_sockets_have_distinct_trusted_identity_and_browser_observation_preserves_desktop_recipient",
  () =>
    Effect.gen(function* () {
      const { backend, sharing, local, remote } = yield* setup();
      const a = yield* remote();
      yield* a.client["application.getHomeDirectory"]();
      const socketId = (yield* Queue.take(backend.metadata)).connectionId;
      yield* local["application.getHomeDirectory"]().pipe(
        RpcClient.withHeaders({
          [rendererConnectionHeader]: String(socketId),
          [correlationIdHeader]: "forged",
        }),
      );
      const desktopId = (yield* Queue.take(backend.metadata)).connectionId;
      const b = yield* remote();
      yield* b.client["application.getHomeDirectory"]();
      const otherId = (yield* Queue.take(backend.metadata)).connectionId;
      expect(new Set([socketId, desktopId, otherId]).size).toBe(3);
      expect(desktopId).not.toBe(1); // Native WebContents ID intentionally collides with a socket's logical ID.
      // Bypass the client header normalizer to exercise duplicate/mixed-case IPC metadata.
      native.emitter?.emit(
        rpcRequestChannel,
        { sender: native.sender },
        {
          _tag: "Request",
          id: "forged-ipc",
          tag: "application.getHomeDirectory",
          payload: null,
          headers: [
            [rendererConnectionHeader, String(socketId)],
            ["X-Cake-Renderer-Connection", String(otherId)],
            [correlationIdHeader, "forged"],
            ["X-Cake-Correlation-Id", "forged-again"],
          ],
        },
      );
      expect(yield* Queue.take(backend.metadata)).toEqual({
        connectionId: desktopId,
        correlationId: `${desktopId}:forged-ipc`,
      });
      const connections = Context.get(backend.context, ClientConnections);
      expect(connections.nativeId(desktopId)).toBe(1);
      expect(connections.nativeId(socketId)).toBeUndefined();
      const workspaces = Context.get(backend.context, ClientWorkspaces);
      workspaces.associateWorkspace(desktopId, "/desktop");
      workspaces.associateWorkspace(socketId, "/browser");
      const requests = Context.get(backend.context, RendererRequestCoordinator);
      const target = {
        sessionId: "00000000-0000-4000-8000-000000000001",
        workingDirectory: "/project",
      };
      yield* local["projectSessions.open"](target);
      yield* a.client["projectSessions.open"](target);
      workspaces.associateWorkspace(otherId, "/other");
      const events = yield* Queue.unbounded<CakeEvent>();
      yield* Context.get(backend.context, ClientEvents)
        .application(desktopId)
        .pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
      yield* Queue.take(events);
      const pending = yield* requests
        .requestProjectControl(
          target.sessionId,
          { _tag: "InvokeAppControl", command: "session.rename", input: { name: "test" } },
          new AbortController().signal,
        )
        .pipe(Effect.forkScoped);
      const event = yield* Queue.take(events);
      assert.equal(event.type, "project-session-control-requested");
      expect(event.sessionId).toBe(target.sessionId);
      const wrong = yield* b.client["projectSessions.respondControl"]({
        sessionId: target.sessionId,
        controlRequestId: event.controlRequestId,
        result: { ok: true },
      }).pipe(Effect.flip);
      expect(wrong.message).toContain("wrong renderer connection");
      yield* a.close();
      expect(yield* Queue.take(backend.cleaned)).toBe(socketId);
      expect(workspaces.workspaceForConnection(socketId)).toBeUndefined();
      expect(workspaces.workspaceForConnection(desktopId)).toBe("/project");
      expect(connections.nativeId(desktopId)).toBe(1);
      expect(workspaces.workspaceForConnection(otherId)).toBe("/other");
      yield* local["projectSessions.respondControl"]({
        sessionId: target.sessionId,
        controlRequestId: event.controlRequestId,
        result: { ok: true },
      });
      expect(yield* Fiber.join(pending)).toEqual({ ok: true });
      // A separate browser-bound session cannot issue desktop-only reverse controls.
      yield* requests.bind({ _tag: "ProjectSession", sessionId: "browser-only" }, otherId);
      const unavailable = yield* requests
        .requestProjectControl(
          "browser-only",
          { _tag: "InvokeAppControl", command: "session.rename", input: { name: "test" } },
          new AbortController().signal,
        )
        .pipe(Effect.flip);
      expect(unavailable.message).toContain("requires a desktop renderer");
      yield* sharing.configure({ enabled: false, bind: "127.0.0.1", port: 0 });
      expect(yield* local["models.list"]()).toEqual([]);
    }).pipe(Effect.scoped),
);

it.live("failed_bind_recovers_and_concurrent_enables_acquire_one_listener", () =>
  Effect.gen(function* () {
    const { sharing, local } = yield* setup();
    const blocker = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>>((resume) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        }),
    );
    const address = blocker.address();
    assert.ok(address && typeof address !== "string");
    const failure = yield* sharing
      .configure({ enabled: true, bind: "127.0.0.1", port: address.port })
      .pipe(Effect.flip);
    expect(failure.message).toContain("EADDRINUSE");
    const failed = yield* sharing.changes().pipe(Stream.runHead);
    expect(failed).toMatchObject({
      value: { status: "failed", error: expect.stringContaining("EADDRINUSE") },
    });
    expect(sharing.keepsProcessAlive()).toBe(false);
    expect(yield* local["models.list"]()).toEqual([]);
    const [first, second] = yield* Effect.all(
      [
        sharing.configure({ enabled: true, bind: "127.0.0.1", port: 0 }),
        sharing.configure({ enabled: true, bind: "127.0.0.1", port: 0 }),
      ],
      { concurrency: "unbounded" },
    );
    expect(first.url).toBe(second.url);
    expect(first.editorPort).toBe(second.editorPort);
    expect(first.status).toBe("serving");
    yield* sharing.configure({ enabled: false, bind: "127.0.0.1", port: 0 });
    expect(sharing.keepsProcessAlive()).toBe(false);
  }).pipe(Effect.scoped),
);

it.live("accepted_host_toggle_outlives_its_request_cancellation", () =>
  Effect.gen(function* () {
    const { sharing } = yield* setup();
    const states = yield* Queue.unbounded<string>();
    yield* sharing.changes().pipe(
      Stream.runForEach((state) => Queue.offer(states, state.status)),
      Effect.forkScoped,
    );
    expect(yield* Queue.take(states)).toBe("disabled");
    const enabling = yield* sharing
      .configure({ enabled: true, bind: "127.0.0.1", port: 0 })
      .pipe(Effect.forkScoped);
    expect(yield* Queue.take(states)).toBe("starting");
    yield* Fiber.interrupt(enabling);
    expect(yield* Queue.take(states)).toBe("serving");
    expect(sharing.keepsProcessAlive()).toBe(true);
    yield* sharing.configure({ enabled: false, bind: "127.0.0.1", port: 0 });
    expect(sharing.keepsProcessAlive()).toBe(false);
  }).pipe(Effect.scoped),
);
