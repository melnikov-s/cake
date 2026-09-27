import { BrowserWindow } from "electron";
import { Effect, Layer, PubSub, Semaphore, Stream } from "effect";
import { ClientConnections } from "../clients/ClientConnections";
import { ClientEvents } from "../clients/ClientEvents";
import { CAKE_TITLE_BAR_HEIGHT, Electron, VSCODE_TITLE_BAR_HEIGHT } from "../electron/Electron";
import { VsCodeServerError } from "./VsCodeServer";
import { VsCodeViews } from "./VsCodeViews";
import { VsCodeViewsRuntime } from "./VsCodeViewsRuntime";

export interface VsCodeViewsLiveOptions {
  readonly preferredTheme: () => Promise<"light" | "dark">;
  readonly onThemeUpdated: (listener: () => void) => () => void;
}
const nativeError = (operation: string, cause: unknown) =>
  new VsCodeServerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** Scope owns native views and native callbacks, never an editor process or workspace read. */
export const makeVsCodeViewsLive = (options: VsCodeViewsLiveOptions) =>
  Layer.effect(
    VsCodeViews,
    Effect.gen(function* () {
      const electron = yield* Electron;
      const connections = yield* ClientConnections;
      const events = yield* ClientEvents;
      const lock = yield* Semaphore.make(1);
      const owners = new Map<number, number>();
      const runtime = new VsCodeViewsRuntime((nativeId, event) => {
        const owner = connections.forNative(nativeId);
        if (owner !== undefined) events.sendTo(owner, event);
      });
      const updates = yield* PubSub.unbounded<void>();
      const unsubscribe = options.onThemeUpdated(() => {
        PubSub.publishUnsafe(updates, undefined);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          runtime.disposeAll();
          owners.clear();
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
      const preferredTheme = Effect.fn("VsCodeViews.preferredTheme")(() =>
        Effect.tryPromise({
          try: options.preferredTheme,
          catch: (cause) => nativeError("preferredTheme", cause),
        }),
      );
      return VsCodeViews.of({
        preferredTheme,
        themeChanges: () =>
          Stream.fromPubSub(updates).pipe(
            Stream.mapEffect(() => preferredTheme().pipe(Effect.orDie)),
            Stream.flatMap((theme) =>
              Stream.fromIterable(
                [...owners.values()].map((connectionId) => ({ connectionId, theme })),
              ),
            ),
          ),
        open: Effect.fn("VsCodeViews.open")((connectionId, endpoint) =>
          lock.withPermits(1)(
            Effect.tryPromise({
              try: (signal) => {
                const sender = electron.requireRendererConnection(connectionId);
                const window = BrowserWindow.fromWebContents(sender);
                if (!window) throw new Error("The editor window is no longer available");
                owners.set(sender.id, connectionId);
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
            owners.delete(nativeId);
            runtime.closeForWindow(nativeId);
          }),
        ),
        backToAgentForWindow: (nativeId) => runtime.backToAgentForWindow(nativeId),
      });
    }),
  );
