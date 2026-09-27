import { BrowserWindow } from "electron";
import { Effect, Layer, Option, Schema } from "effect";
import { jsonValueSchema } from "../../ipc/json-contract";
import { Electron } from "../electron/Electron";
import { ClientEvents } from "../clients/ClientEvents";
import { ProjectAccess } from "../projects/ProjectAccess";
import { Browser, BrowserError } from "./Browser";
import { BrowserRuntime } from "./BrowserRuntime";

const browserError = (operation: string, cause: unknown) =>
  new BrowserError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeBrowserLive = (remote = false) =>
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const electron = yield* Electron;
      const clientEvents = yield* ClientEvents;
      const projectAccess = yield* Effect.serviceOption(ProjectAccess);
      const runtime = new BrowserRuntime({
        allowOwnerTransfer: !remote,
        emit: (ownerId, event) => {
          electron.requireRendererConnection(ownerId);
          clientEvents.sendTo(ownerId, event);
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()));

      const native = <A>(operation: string, execute: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({ try: execute, catch: (cause) => browserError(operation, cause) });
      const sync = <A>(operation: string, execute: () => A) =>
        Effect.try({ try: execute, catch: (cause) => browserError(operation, cause) });

      return Browser.of({
        open: Effect.fn("Browser.open")(function* (connectionId, input) {
          const sender = yield* sync("open", () =>
            electron.requireRendererConnection(connectionId),
          );
          const window = BrowserWindow.fromWebContents(sender);
          if (!window)
            return yield* browserError("open", new Error("Browser window is unavailable"));
          return yield* native("open", (signal) =>
            runtime.open(connectionId, window, input.sessionId, input.url, signal),
          );
        }),
        state: Effect.fn("Browser.state")((connectionId, sessionId) =>
          sync("state", () => {
            electron.requireRendererConnection(connectionId);
            return runtime.stateForOwner(connectionId, sessionId);
          }),
        ),
        updateBounds: Effect.fn("Browser.updateBounds")((connectionId, bounds) =>
          sync("updateBounds", () => {
            electron.requireRendererConnection(connectionId);
            return runtime.updateBounds(connectionId, bounds);
          }),
        ),
        navigate: Effect.fn("Browser.navigate")((connectionId, sessionId, url) =>
          native("navigate", (signal) => {
            electron.requireRendererConnection(connectionId);
            return runtime.navigate(connectionId, sessionId, url, signal);
          }),
        ),
        action: Effect.fn("Browser.action")((connectionId, sessionId, action) =>
          sync("action", () => {
            electron.requireRendererConnection(connectionId);
            return runtime.action(connectionId, sessionId, action);
          }),
        ),
        inspect: Effect.fn("Browser.inspect")((connectionId, sessionId) =>
          native("inspect", () => {
            electron.requireRendererConnection(connectionId);
            return runtime.inspect(connectionId, sessionId);
          }),
        ),
        nativeEnter: Effect.fn("Browser.nativeEnter")(
          function* (connectionId, sessionId, workingDirectory) {
            const sender = yield* sync("nativeEnter", () =>
              electron.requireRendererConnection(connectionId),
            );
            const window = BrowserWindow.fromWebContents(sender);
            if (!window)
              return yield* browserError("nativeEnter", new Error("Browser window is unavailable"));
            yield* native("nativeEnter", (signal) =>
              runtime.open(connectionId, window, sessionId, undefined, signal),
            );
            clientEvents.sendTo(connectionId, {
              type: "browser-entered",
              sessionId,
              workspacePath: workingDirectory,
            });
          },
        ),
        nativeCdp: Effect.fn("Browser.nativeCdp")(
          function* (connectionId, sessionId, method, params) {
            yield* sync("nativeCdp", () => electron.requireRendererConnection(connectionId));
            try {
              if (runtime.owner(sessionId) !== connectionId)
                throw new Error("Browser view belongs to another window");
            } catch (cause) {
              if (cause instanceof Error && cause.message === "Browser mode is not open")
                return { status: "mode-required" as const };
              return yield* browserError("nativeCdp", cause);
            }
            const value = yield* native("nativeCdp", () =>
              runtime.sendCdp(sessionId, method, params),
            );
            return { status: "completed" as const, value };
          },
        ),
        nativeEvents: Effect.fn("Browser.nativeEvents")(
          function* (connectionId, sessionId, methods, limit, clear) {
            yield* sync("nativeEvents", () => electron.requireRendererConnection(connectionId));
            try {
              if (runtime.owner(sessionId) !== connectionId)
                throw new Error("Browser view belongs to another window");
            } catch (cause) {
              if (cause instanceof Error && cause.message === "Browser mode is not open")
                return { status: "mode-required" as const };
              return yield* browserError("nativeEvents", cause);
            }
            const value = yield* sync("nativeEvents", () =>
              runtime.takeCdpEvents(sessionId, methods, limit, clear),
            );
            return { status: "completed" as const, value };
          },
        ),
        enterProjectBrowser: Effect.fn("Browser.enterProjectBrowser")(
          function* (sessionId, workingDirectory) {
            if (
              Option.isNone(projectAccess) ||
              !(yield* projectAccess.value.isAllowed(workingDirectory))
            )
              return yield* browserError(
                "enterProjectBrowser",
                new Error("Project path is not allowed"),
              );
            const candidates = electron.windowsForWorkspace(workingDirectory);
            const selected =
              candidates.find(([, window]) => window.isFocused()) ?? candidates.at(0);
            if (!selected)
              return yield* browserError(
                "enterProjectBrowser",
                new Error("No Cake window has this project open"),
              );
            const [ownerId, window] = selected;
            yield* native("enterProjectBrowser", (signal) =>
              runtime.open(ownerId, window, sessionId, undefined, signal),
            );
            clientEvents.sendTo(ownerId, {
              type: "browser-entered",
              sessionId,
              workspacePath: workingDirectory,
            });
          },
        ),
        sendProjectCdp: Effect.fn("Browser.sendProjectCdp")(
          function* (sessionId, workingDirectory, method, params) {
            if (
              Option.isNone(projectAccess) ||
              !(yield* projectAccess.value.isAllowed(workingDirectory))
            )
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
            if (
              Option.isNone(projectAccess) ||
              !(yield* projectAccess.value.isAllowed(workingDirectory))
            )
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

export const BrowserLive = makeBrowserLive();
