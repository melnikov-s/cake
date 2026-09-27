import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { describe, expect, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/domain/application/application-data";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../../src/services/clients/ClientConnections";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";
import { ApplicationState } from "../../../../src/services/storage/ApplicationState";
import { VsCodeServer } from "../../../../src/services/vscode/VsCodeServer";
import {
  makeInstallSingleFlight,
  makeVsCodeServerLive,
} from "../../../../src/services/vscode/VsCodeServerLive";
import type { CompanionManifest } from "../../../../src/services/vscode/VsCodeServerRuntime";

const native = vi.hoisted(() => ({
  releaseServer: vi.fn(),
  releaseConnection: vi.fn(),
  startServer: vi.fn(),
}));

vi.mock("../../../../src/services/vscode/VsCodeServerRuntime", () => ({
  VSCODE_SERVER_IDLE_TTL: 300_000,
  VsCodeServerRuntime: class {
    readonly props: {
      readonly acquireServer: (
        workspacePath: string,
        binary: string,
        signal?: AbortSignal,
      ) => Promise<unknown>;
    };

    constructor(props: {
      readonly acquireServer: (
        workspacePath: string,
        binary: string,
        signal?: AbortSignal,
      ) => Promise<unknown>;
    }) {
      this.props = props;
    }

    snapshotState() {
      return { status: "ready" as const };
    }

    async acquire(
      connectionId: number,
      workspacePath: string,
      _theme: "light" | "dark",
      signal?: AbortSignal,
    ) {
      await this.props.acquireServer(workspacePath, "/fake/vscode", signal);
      return {
        connectionId,
        workspacePath,
        id: "lease",
        url: "http://127.0.0.1:4321/",
        revocation: new AbortController(),
        flavor: "codeserver",
        presentedWorkspacePath: workspacePath,
        visible: false,
      };
    }
    leaseFor() {
      return undefined;
    }
    releaseLease() {}
    releaseConnection(connectionId: number) {
      native.releaseConnection(connectionId);
    }

    startServer(workspacePath: string, binary: string, signal?: AbortSignal) {
      return native.startServer(workspacePath, binary, signal);
    }

    releaseServer(instance: unknown) {
      native.releaseServer(instance);
    }

    disposeAll() {}
  },
}));

const companionManifest: CompanionManifest = {
  name: "cake-companion",
  displayName: "Cake Companion",
  description: "Test companion",
  version: "0.0.0",
  publisher: "cake",
  private: true,
  license: "UNLICENSED",
  engines: { vscode: "*" },
  main: "./extension.js",
  activationEvents: [],
  contributes: { commands: [] },
};

const liveLayer = (allowed: (path: string) => boolean = () => true) =>
  makeVsCodeServerLive({
    root: "/tmp/cake-vscode-test",
    companionManifest,
    companionSource: "",
    companionThemes: [],
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
        ClientEventsLive,
        Layer.mock(ProjectAccess, { isAllowed: (path) => Effect.succeed(allowed(path)) }),
      ),
    ),
    Layer.provideMerge(ClientConnectionsLive),
  );

describe("VsCodeServerLive server acquisition", () => {
  it.effect(
    "rejects editor actions without a viewer before reading the workspace or waiting for a companion",
    () =>
      Effect.gen(function* () {
        const id = (yield* ClientConnections).desktop(94);
        const server = yield* VsCodeServer;
        const request = { requestId: "no-viewer", workspacePath: "/nonexistent-server-workspace" };
        for (const action of [
          server.openSourceControl(id, request),
          server.reveal(id, {
            ...request,
            location: { kind: "working-directory", path: "file.ts" },
          }),
          server.performEditorAction(id, { ...request, action: { type: "editor.status" } }),
          server.updateSelectionHighlights(id, { ...request, highlights: { locations: [] } }),
          server.updateAnnotations(id, {
            ...request,
            snapshot: { sessionId: "session", annotations: [] },
          }),
        ]) {
          const failure = yield* action.pipe(Effect.flip);
          expect(failure.operation).toBe("requireViewer");
          expect(failure.message).toContain("does not own");
        }
      }).pipe(Effect.provide(liveLayer())),
  );
  it.effect(
    "acquires a code-server lease for a connected browser but rejects an unknown client",
    () =>
      Effect.gen(function* () {
        native.startServer.mockReset().mockResolvedValue({ workspacePath: "/workspace" });
        const connections = yield* ClientConnections;
        const id = connections.socket();
        const server = yield* VsCodeServer;
        const request = {
          requestId: "browser",
          workspacePath: "/workspace",
          theme: "dark" as const,
        };
        const lease = yield* server.acquire(id, request);
        expect(lease.connectionId).toBe(id);
        expect(native.startServer).toHaveBeenCalledOnce();
        connections.release(id);
        const failure = yield* server.acquire(id, request).pipe(Effect.flip);
        expect(failure.message).toContain("connected client");
        expect(native.startServer).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(liveLayer())),
  );

  it.effect("rejects an unapproved project before acquiring a browser editor process", () =>
    Effect.gen(function* () {
      native.startServer.mockClear();
      const id = (yield* ClientConnections).socket();
      const failure = yield* (yield* VsCodeServer)
        .acquire(id, { requestId: "wrong-project", workspacePath: "/wrong", theme: "dark" })
        .pipe(Effect.flip);
      expect(failure.operation).toBe("authorizeWorkingDirectory");
      expect(failure.message).toContain("not selected by the user");
      expect(native.startServer).not.toHaveBeenCalled();
    }).pipe(Effect.provide(liveLayer((path) => path === "/workspace"))),
  );

  it.effect("releases an acquisition whose logical desktop disconnects during startup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let finish!: () => void;
      native.releaseConnection.mockClear();
      native.startServer.mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ workspacePath: "/workspace" });
            Deferred.doneUnsafe(started, Effect.void);
          }),
      );
      const connections = yield* ClientConnections;
      const id = connections.desktop(93);
      const server = yield* VsCodeServer;
      const opening = yield* server
        .acquire(id, { requestId: "disconnect", workspacePath: "/workspace", theme: "dark" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      connections.release(id);
      finish();
      expect((yield* Fiber.join(opening)).message).toContain("disconnected");
      expect(native.releaseConnection).toHaveBeenCalledWith(id);
    }).pipe(Effect.provide(liveLayer())),
  );

  it.effect("releases a browser lease if its socket disconnects during startup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let finish!: () => void;
      native.releaseConnection.mockClear();
      native.startServer.mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ workspacePath: "/workspace" });
            Deferred.doneUnsafe(started, Effect.void);
          }),
      );
      const connections = yield* ClientConnections;
      const id = connections.socket();
      const server = yield* VsCodeServer;
      const opening = yield* server
        .acquire(id, {
          requestId: "browser-disconnect",
          workspacePath: "/workspace",
          theme: "dark",
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      connections.release(id);
      finish();
      expect((yield* Fiber.join(opening)).message).toContain("disconnected");
      expect(native.releaseConnection).toHaveBeenCalledWith(id);
    }).pipe(Effect.provide(liveLayer())),
  );

  it.effect("retries a failed server start for the same workspace", () =>
    Effect.gen(function* () {
      native.releaseServer.mockReset();
      native.startServer
        .mockReset()
        .mockRejectedValueOnce(new Error("startup failed"))
        .mockResolvedValue({ workspacePath: "/workspace" });

      const { cachedResult, failure, result } = yield* Effect.gen(function* () {
        const vscode = yield* VsCodeServer;
        const connectionId = (yield* ClientConnections).desktop(91);
        const request = {
          requestId: "open-1",
          workspacePath: "/workspace",
          theme: "dark" as const,
        };
        const failure = yield* vscode.acquire(connectionId, request).pipe(Effect.flip);
        const result = yield* vscode.acquire(connectionId, request);
        const cachedResult = yield* vscode.acquire(connectionId, request);
        return { cachedResult, failure, result };
      }).pipe(Effect.provide(liveLayer()));

      expect(failure.operation).toBe("acquire");
      expect(result).toMatchObject({ id: "lease", workspacePath: "/workspace" });
      expect(cachedResult).toEqual(result);
      expect(native.startServer).toHaveBeenCalledTimes(2);
      expect(native.releaseServer).toHaveBeenCalledOnce();
    }),
  );
});

describe("VsCodeServerLive install single-flight", () => {
  it.effect("keeps the shared install alive when its initiating caller is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const runs = yield* Ref.make(0);
        const install = Effect.gen(function* () {
          yield* Ref.update(runs, (count) => count + 1);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
        });
        const runInstall = yield* makeInstallSingleFlight(install);

        const initiatingCaller = yield* Effect.forkChild(runInstall);
        yield* Deferred.await(started);
        const waitingCaller = yield* Effect.forkChild(runInstall);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(initiatingCaller);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(waitingCaller);

        expect(yield* Ref.get(runs)).toBe(1);
      }),
    ),
  );

  it.effect("delivers the shared typed installation failure to every waiter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const runInstall = yield* makeInstallSingleFlight(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
            return yield* Effect.fail("installation failed" as const);
          }),
        );

        const first = yield* Effect.forkChild(Effect.flip(runInstall));
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(Effect.flip(runInstall));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(finish, undefined);

        expect(yield* Fiber.join(first)).toBe("installation failed");
        expect(yield* Fiber.join(second)).toBe("installation failed");
      }),
    ),
  );
});
