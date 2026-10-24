import { BrowserWindow } from "electron";
import { Effect, Layer, Semaphore, Stream } from "effect";
import { ClientConnections } from "../clients/ClientConnections";
import { ClientEvents } from "../clients/ClientEvents";
import { CAKE_TITLE_BAR_HEIGHT, Electron, VSCODE_TITLE_BAR_HEIGHT } from "../electron/Electron";
import { VsCodeServerError } from "../../contracts/vscode/vs-code-server-errors";
import { VsCodeViews } from "./VsCodeViews";
import { VsCodeViewsRuntime } from "./VsCodeViewsRuntime";

const nativeError = (operation: string, cause: unknown) =>
  new VsCodeServerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** Scope owns native views and native callbacks, never an editor process or workspace read. */
export const VsCodeViewsLive = Layer.effect(
  VsCodeViews,
  Effect.gen(function* () {
    const electron = yield* Electron;
    const connections = yield* ClientConnections;
    const events = yield* ClientEvents;
    const lock = yield* Semaphore.make(1);
    const runtime = new VsCodeViewsRuntime((nativeId, event) => {
      const owner = connections.forNative(nativeId);
      if (owner !== undefined) events.sendTo(owner, event);
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        runtime.disposeAll();
      }),
    );
    yield* electron.fullscreenSurfaceChanges().pipe(
      Stream.runForEach(({ connectionId, open }) =>
        Effect.sync(() => {
          const nativeId = connections.nativeId(connectionId);
          if (nativeId !== undefined) runtime.setFullscreenSurfaceOpen(nativeId, open);
        }),
      ),
      Effect.forkScoped,
    );
    return VsCodeViews.of({
      open: Effect.fn("VsCodeViews.open")((connectionId, endpoint) =>
        lock.withPermits(1)(
          Effect.tryPromise({
            try: (signal) => {
              const sender = electron.requireRendererConnection(connectionId);
              const window = BrowserWindow.fromWebContents(sender);
              if (!window) throw new Error("The editor window is no longer available");
              return runtime.open(sender.id, window, endpoint, signal);
            },
            catch: (cause) => nativeError("openView", cause),
          }),
        ),
      ),
      updateBounds: Effect.fn("VsCodeViews.updateBounds")((connectionId, bounds) =>
        Effect.try({
          try: () => {
            const sender = electron.requireRendererConnection(connectionId);
            const window = BrowserWindow.fromWebContents(sender);
            if (window)
              electron.centerTrafficLights(
                window,
                bounds.visible ? VSCODE_TITLE_BAR_HEIGHT : CAKE_TITLE_BAR_HEIGHT,
              );
            runtime.updateBounds(sender.id, bounds);
          },
          catch: (cause) => nativeError("updateBounds", cause),
        }),
      ),
      focusCake: Effect.fn("VsCodeViews.focusCake")((connectionId) =>
        Effect.sync(() => {
          const nativeId = connections.nativeId(connectionId);
          if (nativeId === undefined) return;
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.id === nativeId)
            ?.webContents.focus();
        }),
      ),
      closeForWindow: Effect.fn("VsCodeViews.closeForWindow")((nativeId) =>
        Effect.sync(() => {
          runtime.closeForWindow(nativeId);
        }),
      ),
      backToAgentForWindow: (nativeId) => runtime.backToAgentForWindow(nativeId),
    });
  }),
);
