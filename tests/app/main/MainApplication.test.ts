import { EventEmitter } from "node:events";
import type { Event } from "electron";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer } from "effect";
import { describe, expect, vi } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application-data";
import type { ApplicationState as ApplicationStateValue } from "../../../src/domain/application-data";
import type { WorktreeRecord } from "../../../src/ipc/worktree-contract";
import { MainApplication } from "../../../src/main/MainApplication";
import { Electron } from "../../../src/services/electron/Electron";
import { PiSessions } from "../../../src/services/pi/PiSessions";
import { ProjectSessionIntegrations } from "../../../src/services/pi/ProjectSessionIntegrations";
import { PluginRuntime, PluginRuntimeError } from "../../../src/services/plugins/PluginRuntime";
import { ProjectSessionLifecycle } from "../../../src/services/project-sessions/ProjectSessionLifecycle";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { RewordingRequests } from "../../../src/services/projects/RewordingRequests";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";

class TestApplication extends EventEmitter {
  readonly quit = vi.fn(() => this.emit("before-quit", { preventDefault: vi.fn() }));
  constructor(private readonly ready: Promise<void> = Promise.resolve()) {
    super();
  }
  override on(eventName: "before-quit", listener: (event: Event) => void): this;
  override on(eventName: "window-all-closed", listener: () => void): this;
  override on(
    eventName: "before-quit" | "window-all-closed",
    listener: ((event: Event) => void) | (() => void),
  ): this {
    super.on(eventName, listener);
    this.emit(`listener:${eventName}`);
    return this;
  }
  whenReady() {
    return this.ready;
  }
  waitForListener(eventName: string) {
    if (this.listenerCount(eventName) > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.once(`listener:${eventName}`, resolve));
  }
  requestQuit() {
    const event = { preventDefault: vi.fn() };
    this.emit("before-quit", event);
    return event;
  }
}

const testLayer = (input?: {
  readonly stop?: () => void;
  readonly initializeCustomization?: () => Effect.Effect<void, PluginRuntimeError>;
  readonly applicationState?: ApplicationStateValue;
  readonly worktrees?: ReadonlyArray<WorktreeRecord>;
  readonly allow?: (path: string) => void;
}) => {
  const state = input?.applicationState ?? defaultApplicationState();
  return Layer.mergeAll(
    Layer.mock(ApplicationState, {
      initialize: () => Effect.succeed(state),
      snapshot: () => state,
    }),
    Layer.mock(Electron, {
      start: () => Effect.void,
      stop: () => Effect.sync(() => input?.stop?.()),
      sendTo: () => {},
      broadcast: () => {},
      requireRendererConnection: () => {
        throw new Error("No renderer connection in this test");
      },
      workspaceForConnection: () => undefined,
      associateWorkspace: () => {},
      forgetWorkspace: () => {},
      windowsForWorkspace: () => [],
      centerTrafficLights: () => {},
      reloadAll: () => {},
      reloadWindowWithFactory: () => {},
    }),
    Layer.mock(PluginRuntime, {
      initializeCustomization: input?.initializeCustomization ?? (() => Effect.void),
      startupRenderer: () => ({ kind: "factory" }),
      trackRenderer: () => {},
      rendererProcessGone: () => {},
      disposeOwner: () => {},
      recoveryContext: () => undefined,
      agentResources: () => ({ skills: [], prompts: [], extensions: [] }),
    }),
    Layer.mock(ProjectSessionLifecycle, {}),
    Layer.mock(ProjectAccess, {
      allow: (path) => Effect.sync(() => input?.allow?.(path)),
      clearOwner: () => Effect.void,
      rememberSessionLocation: () => Effect.void,
    }),
    Layer.mock(RewordingRequests, {
      acquire: () => Effect.succeed(new AbortController()),
      release: () => Effect.void,
      disposeOwner: () => Effect.void,
    }),
    Layer.mock(ProjectSessionIntegrations, { cancelPendingRequests: () => Effect.void }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed(input?.worktrees ?? []) }),
    Layer.mock(PiSessions, {}),
    Layer.mock(Terminal, {}),
    Layer.mock(VsCodeServer, {
      refreshStatus: () => Effect.void,
      closeForWindow: () => Effect.void,
      backToAgentForWindow: () => Effect.succeed(false),
    }),
  );
};

const program = (application: TestApplication, layer = testLayer()) =>
  MainApplication({
    application,
    platform: "linux",
    initializeNativeProtocols: () => {},
  }).pipe(Effect.provide(layer));

describe("MainApplication", () => {
  it.effect("starts after Electron is ready and stops on a quit request", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const stop = vi.fn();
      const fiber = yield* Effect.forkChild(program(application, testLayer({ stop })));
      yield* Effect.promise(() => application.waitForListener("before-quit"));
      const event = application.requestQuit();
      yield* Fiber.join(fiber);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(application.listenerCount("before-quit")).toBe(0);
    }),
  );

  it.effect("delegates non-macOS window closure to Electron quit", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const fiber = yield* Effect.forkChild(program(application));
      yield* Effect.promise(() => application.waitForListener("window-all-closed"));
      application.emit("window-all-closed");
      yield* Fiber.join(fiber);
      expect(application.quit).toHaveBeenCalledOnce();
    }),
  );

  it.effect("restores access to registered Projects and their managed worktrees", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const allow = vi.fn();
      const state: ApplicationStateValue = {
        ...defaultApplicationState(),
        projects: [
          {
            path: "/projects/cake",
            name: "cake",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
      const layer = testLayer({
        applicationState: state,
        allow,
        worktrees: [
          {
            projectPath: "/projects/cake",
            worktreePath: "/worktrees/cake-feature",
            branch: "feature",
            baseBranch: "main",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            projectPath: "/projects/not-registered",
            worktreePath: "/worktrees/not-registered",
            branch: "other",
            baseBranch: "main",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const fiber = yield* Effect.forkChild(program(application, layer));
      yield* Effect.promise(() => application.waitForListener("window-all-closed"));
      application.emit("window-all-closed");
      yield* Fiber.join(fiber);
      expect(allow).toHaveBeenCalledWith("/projects/cake");
      expect(allow).toHaveBeenCalledWith("/worktrees/cake-feature");
      expect(allow).not.toHaveBeenCalledWith("/worktrees/not-registered");
    }),
  );

  it.effect("runs finalization when the application Scope is interrupted", () =>
    Effect.gen(function* () {
      const application = new TestApplication(new Promise(() => {}));
      const stop = vi.fn();
      const fiber = yield* Effect.forkChild(program(application, testLayer({ stop })));
      yield* Effect.promise(() => application.waitForListener("before-quit"));
      yield* Fiber.interrupt(fiber);
      expect(stop).toHaveBeenCalledOnce();
      expect(application.listenerCount("before-quit")).toBe(0);
      expect(application.listenerCount("window-all-closed")).toBe(0);
    }),
  );

  it.effect("reports failed customization initialization and still finalizes", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const stop = vi.fn();
      const reportDefect = vi.fn();
      const exit = yield* Effect.exit(
        MainApplication({
          application,
          platform: "linux",
          reportDefect,
          initializeNativeProtocols: () => {},
        }).pipe(
          Effect.provide(
            testLayer({
              stop,
              initializeCustomization: () =>
                new PluginRuntimeError({ message: "bootstrap failed" }),
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(reportDefect).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    }),
  );
});
