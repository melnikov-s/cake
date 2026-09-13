import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { describe, expect, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/domain/application/application-data";
import { Electron } from "../../../../src/services/electron/Electron";
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

    open(
      _webContentsId: number,
      _getWindow: () => unknown,
      workspacePath: string,
      signal?: AbortSignal,
    ) {
      return this.props.acquireServer(workspacePath, "/fake/vscode", signal);
    }

    startServer(workspacePath: string, binary: string, signal?: AbortSignal) {
      return native.startServer(workspacePath, binary, signal);
    }

    releaseServer(instance: unknown) {
      native.releaseServer(instance);
    }

    setFullscreenSurfaceOpen() {}
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

const liveLayer = () =>
  makeVsCodeServerLive({
    root: "/tmp/cake-vscode-test",
    companionManifest,
    companionMain: "",
    companionThemes: [],
    preferredTheme: () => Promise.resolve("light"),
    onThemeUpdated: () => () => {},
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
        Layer.mock(Electron, {
          broadcast: () => {},
          sendTo: () => {},
          fullscreenSurfaceChanges: () => Stream.empty,
          requireRendererConnection: () => Object.assign(Object.create(null), { id: 1 }),
          workspaceForConnection: () => undefined,
          associateWorkspace: () => {},
          forgetWorkspace: () => {},
          windowsForWorkspace: () => [],
          centerTrafficLights: () => {},
        }),
        Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) }),
      ),
    ),
  );

describe("VsCodeServerLive server acquisition", () => {
  it.effect("retries a failed server start for the same workspace", () =>
    Effect.gen(function* () {
      native.releaseServer.mockReset();
      native.startServer
        .mockReset()
        .mockRejectedValueOnce(new Error("startup failed"))
        .mockResolvedValue({ workspacePath: "/workspace" });

      const { cachedResult, failure, result } = yield* Effect.gen(function* () {
        const vscode = yield* VsCodeServer;
        const request = { requestId: "open-1", workspacePath: "/workspace" };
        const failure = yield* vscode.open(1, request).pipe(Effect.flip);
        const result = yield* vscode.open(1, request);
        const cachedResult = yield* vscode.open(1, request);
        return { cachedResult, failure, result };
      }).pipe(Effect.provide(liveLayer()));

      expect(failure.operation).toBe("open");
      expect(result).toEqual({ requestId: "open-1" });
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
