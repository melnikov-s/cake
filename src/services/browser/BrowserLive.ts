import { BrowserWindow } from "electron";
import { Effect, Layer, Schema } from "effect";
import { jsonValueSchema } from "../../ipc/json-contract";
import { Electron } from "../electron/Electron";
import { ProjectAccess } from "../projects/ProjectAccess";
import { Browser, BrowserError } from "./Browser";
import { BrowserRuntime } from "./BrowserRuntime";

const browserError = (operation: string, cause: unknown) =>
  new BrowserError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const BrowserLive = Layer.effect(
  Browser,
  Effect.gen(function* () {
    const electron = yield* Electron;
    const projectAccess = yield* ProjectAccess;
    const runtime = new BrowserRuntime({
      emit: (ownerId, event) => {
        const sender = electron.requireRendererConnection(ownerId);
        electron.sendTo(sender, event);
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()));

    const native = <A>(operation: string, execute: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: execute, catch: (cause) => browserError(operation, cause) });
    const sync = <A>(operation: string, execute: () => A) =>
      Effect.try({ try: execute, catch: (cause) => browserError(operation, cause) });

    return Browser.of({
      open: Effect.fn("Browser.open")(function* (connectionId, input) {
        const sender = yield* sync("open", () => electron.requireRendererConnection(connectionId));
        const window = BrowserWindow.fromWebContents(sender);
        if (!window) return yield* browserError("open", new Error("Browser window is unavailable"));
        return yield* native("open", (signal) =>
          runtime.open(sender.id, window, input.sessionId, input.url, signal),
        );
      }),
      state: Effect.fn("Browser.state")((sessionId) =>
        sync("state", () => runtime.state(sessionId)),
      ),
      updateBounds: Effect.fn("Browser.updateBounds")((connectionId, bounds) =>
        sync("updateBounds", () => {
          const sender = electron.requireRendererConnection(connectionId);
          return runtime.updateBounds(sender.id, bounds);
        }),
      ),
      navigate: Effect.fn("Browser.navigate")((sessionId, url) =>
        native("navigate", (signal) => runtime.navigate(sessionId, url, signal)),
      ),
      action: Effect.fn("Browser.action")((sessionId, action) =>
        sync("action", () => runtime.action(sessionId, action)),
      ),
      inspect: Effect.fn("Browser.inspect")((sessionId) =>
        native("inspect", () => runtime.inspect(sessionId)),
      ),
      enterProjectBrowser: Effect.fn("Browser.enterProjectBrowser")(
        function* (sessionId, workingDirectory) {
          if (!(yield* projectAccess.isAllowed(workingDirectory)))
            return yield* browserError(
              "enterProjectBrowser",
              new Error("Project path is not allowed"),
            );
          const candidates = electron.windowsForWorkspace(workingDirectory);
          const selected = candidates.find(([, window]) => window.isFocused()) ?? candidates.at(0);
          if (!selected)
            return yield* browserError(
              "enterProjectBrowser",
              new Error("No Cake window has this project open"),
            );
          const [ownerId, window] = selected;
          yield* native("enterProjectBrowser", (signal) =>
            runtime.open(ownerId, window, sessionId, undefined, signal),
          );
          electron.sendTo(window.webContents, {
            type: "browser-entered",
            sessionId,
            workspacePath: workingDirectory,
          });
        },
      ),
      sendProjectCdp: Effect.fn("Browser.sendProjectCdp")(
        function* (sessionId, workingDirectory, method, params) {
          if (!(yield* projectAccess.isAllowed(workingDirectory)))
            return yield* browserError("cdp", new Error("Project path is not allowed"));
          try {
            runtime.state(sessionId);
          } catch {
            return { status: "mode-required" as const };
          }
          const value = yield* native("cdp", () => runtime.sendCdp(sessionId, method, params));
          const decoded = yield* Schema.decodeUnknownEffect(jsonValueSchema)(value).pipe(
            Effect.mapError((cause) => browserError("cdp", cause)),
          );
          return { status: "completed" as const, value: decoded };
        },
      ),
      takeProjectCdpEvents: Effect.fn("Browser.takeProjectCdpEvents")(
        function* (sessionId, workingDirectory, methods, limit, clear) {
          if (!(yield* projectAccess.isAllowed(workingDirectory)))
            return yield* browserError("cdpEvents", new Error("Project path is not allowed"));
          try {
            runtime.state(sessionId);
          } catch {
            return { status: "mode-required" as const };
          }
          const value = yield* sync("cdpEvents", () =>
            runtime.takeCdpEvents(sessionId, methods, limit, clear),
          );
          const decoded = yield* Schema.decodeUnknownEffect(jsonValueSchema)(value).pipe(
            Effect.mapError((cause) => browserError("cdpEvents", cause)),
          );
          return { status: "completed" as const, value: decoded };
        },
      ),
      closeForWindow: Effect.fn("Browser.closeForWindow")((ownerId) =>
        Effect.sync(() => runtime.closeForWindow(ownerId)),
      ),
    });
  }),
);
