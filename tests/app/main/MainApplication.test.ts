import { EventEmitter } from "node:events";
import type { Event } from "electron";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, vi } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { DesktopSharing } from "../../../src/services/electron/DesktopSharing";
import { MainApplication } from "../../../src/main/MainApplication";
import { Electron, type ElectronWindowLifecycle } from "../../../src/services/electron/Electron";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { RewordingRequests } from "../../../src/services/projects/RewordingRequests";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { VsCodeViews } from "../../../src/services/vscode/VsCodeViews";

class TestApplication extends EventEmitter {
  readonly quit = vi.fn(() => this.emit("before-quit", { preventDefault: vi.fn() }));
  readonly requestSingleInstanceLock = vi.fn(() => this.primaryInstance);
  constructor(
    private readonly ready: Promise<void> = Promise.resolve(),
    private readonly primaryInstance = true,
  ) {
    super();
  }
  override on(eventName: "before-quit", listener: (event: Event) => void): this;
  override on(eventName: "window-all-closed" | "second-instance", listener: () => void): this;
  override on(
    eventName: "before-quit" | "window-all-closed" | "second-instance",
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
  readonly keepsProcessAlive?: () => boolean;
  readonly stop?: () => void;
  readonly start?: (lifecycle: ElectronWindowLifecycle) => void;
  readonly focusOrCreateWindow?: () => void;
  readonly closeTerminalOwner?: (ownerId: number) => void;
  readonly closeEditorForWindow?: (ownerId: number) => void;
  readonly clearOwner?: (ownerId: number) => void;
  readonly disposeRewordingOwner?: (ownerId: number) => void;
  readonly releaseRendererConnection?: (ownerId: number) => void;
}) => {
  const state = defaultApplicationState();
  return Layer.mergeAll(
    Layer.mock(DesktopSharing, { keepsProcessAlive: input?.keepsProcessAlive ?? (() => false) }),
    Layer.mock(ApplicationState, {
      snapshot: () => state,
    }),
    Layer.mock(Electron, {
      start: (lifecycle) => Effect.sync(() => input?.start?.(lifecycle)),
      focusOrCreateWindow: () => Effect.sync(() => input?.focusOrCreateWindow?.()),
      stop: () => Effect.sync(() => input?.stop?.()),
      requireRendererConnection: () => {
        throw new Error("No renderer connection in this test");
      },
      windowsForWorkspace: () => [],
      centerTrafficLights: () => {},
    }),
    Layer.mock(ProjectAccess, {
      allow: () => Effect.void,
      clearOwner: (ownerId) => Effect.sync(() => input?.clearOwner?.(ownerId)),
      rememberSessionLocation: () => Effect.void,
    }),
    Layer.mock(RewordingRequests, {
      acquire: () => Effect.succeed(new AbortController()),
      release: () => Effect.void,
      disposeOwner: (ownerId) => Effect.sync(() => input?.disposeRewordingOwner?.(ownerId)),
    }),
    Layer.mock(RendererRequestCoordinator, {
      releaseConnection: (ownerId) =>
        Effect.sync(() => input?.releaseRendererConnection?.(ownerId)),
    }),
    Layer.mock(Terminal, {
      closeOwner: (ownerId) => Effect.sync(() => input?.closeTerminalOwner?.(ownerId)),
    }),
    Layer.mock(VsCodeServer, { leaseFor: () => undefined, releaseConnection: () => Effect.void }),
    Layer.mock(VsCodeViews, {
      closeForWindow: (ownerId) => Effect.sync(() => input?.closeEditorForWindow?.(ownerId)),
      backToAgentForWindow: () => false,
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
  it.effect(
    "remote native menus defer reword validation to the backend, not absent local state",
    () =>
      Effect.gen(function* () {
        for (const mode of ["remote", "local-unconfigured", "local-configured"] as const) {
          const application = new TestApplication();
          const started = yield* Deferred.make<ElectronWindowLifecycle>();
          const native = Layer.mock(Electron, {
            start: (lifecycle) => Deferred.succeed(started, lifecycle).pipe(Effect.asVoid),
            stop: () => Effect.void,
            requireRendererConnection: () => {
              throw new Error("Unexpected native connection lookup");
            },
            windowsForWorkspace: () => [],
            centerTrafficLights: () => {},
          });
          const state = {
            ...defaultApplicationState(),
            utilityModel:
              mode === "local-configured"
                ? { provider: "fixture", modelId: "model", thinkingLevel: "off" as const }
                : undefined,
          };
          const layer =
            mode === "remote"
              ? native
              : Layer.merge(native, Layer.mock(ApplicationState, { snapshot: () => state }));
          const fiber = yield* Effect.forkChild(
            MainApplication({ application, initializeNativeProtocols: () => {} }).pipe(
              Effect.provide(layer),
            ),
          );
          const lifecycle = yield* Deferred.await(started);
          expect(lifecycle.canRewordSelection()).toBe(mode !== "local-unconfigured");
          application.requestQuit();
          yield* Fiber.join(fiber);
        }
      }),
  );

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

  it.effect("exits before touching Electron when another instance owns the profile", () =>
    Effect.gen(function* () {
      // Electron never becomes ready here: the secondary instance must not wait for it.
      const application = new TestApplication(new Promise(() => {}), false);
      const start = vi.fn();
      const stop = vi.fn();
      yield* program(application, testLayer({ start, stop }));
      expect(application.requestSingleInstanceLock).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(application.listenerCount("before-quit")).toBe(0);
    }),
  );

  it.effect("brings the primary instance's window forward on a second launch", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const focused = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        program(
          application,
          testLayer({ focusOrCreateWindow: () => Deferred.doneUnsafe(focused, Effect.void) }),
        ),
      );
      yield* Effect.promise(() => application.waitForListener("second-instance"));
      application.emit("second-instance");
      yield* Deferred.await(focused);
      application.requestQuit();
      yield* Fiber.join(fiber);
      expect(application.listenerCount("second-instance")).toBe(0);
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

  it.effect("desktop_window_close_keeps_enabled_server_alive_until_explicit_quit", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const stop = vi.fn();
      const fiber = yield* Effect.forkChild(
        program(application, testLayer({ stop, keepsProcessAlive: () => true })),
      );
      yield* Effect.promise(() => application.waitForListener("window-all-closed"));
      application.emit("window-all-closed");
      expect(application.quit).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      application.requestQuit();
      yield* Fiber.join(fiber);
      expect(stop).toHaveBeenCalledOnce();
    }),
  );

  it.effect("owns native window cleanup inside the application Scope", () =>
    Effect.gen(function* () {
      const application = new TestApplication();
      const operations: string[] = [];
      let lifecycle: ElectronWindowLifecycle | undefined;
      const started = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const record = (operation: string) => {
        operations.push(operation);
        if (operations.length === 5) Deferred.doneUnsafe(cleaned, Effect.void);
      };
      const fiber = yield* Effect.forkChild(
        program(
          application,
          testLayer({
            start: (value) => {
              lifecycle = value;
              Deferred.doneUnsafe(started, Effect.void);
            },
            closeTerminalOwner: (ownerId) => record(`terminal:${ownerId}`),
            closeEditorForWindow: (ownerId) => record(`editor:${ownerId}`),
            clearOwner: (ownerId) => record(`access:${ownerId}`),
            disposeRewordingOwner: (ownerId) => record(`rewording:${ownerId}`),
            releaseRendererConnection: (ownerId) => record(`requests:${ownerId}`),
          }),
        ),
      );
      yield* Deferred.await(started);
      lifecycle?.onWindowClosed(17, "/projects/cake", 42);
      yield* Deferred.await(cleaned);
      expect(operations.toSorted()).toEqual(
        ["terminal:17", "editor:42", "access:17", "rewording:17", "requests:17"].toSorted(),
      );
      application.emit("window-all-closed");
      yield* Fiber.join(fiber);
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
});
