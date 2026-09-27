import { Effect, Layer, Schema } from "effect";
import { cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import type { jsonValueSchema } from "../../ipc/json-contract";
import { ProjectAccess } from "../projects/ProjectAccess";
import { RendererRequestCoordinator } from "../renderer-requests/RendererRequestCoordinator";
import { Browser, BrowserError } from "./Browser";

/** Headless backend control plane; Chromium and native windows never exist here. */
export const RemoteBrowserLive = Layer.effect(
  Browser,
  Effect.gen(function* () {
    const access = yield* ProjectAccess;
    const requests = yield* RendererRequestCoordinator;
    const unavailable = (operation: string) =>
      new BrowserError({ operation, message: "Browser views exist only on the desktop" });
    const allowed = Effect.fn("RemoteBrowser.allowed")(function* (operation: string, path: string) {
      if (!(yield* access.isAllowed(path)))
        return yield* new BrowserError({ operation, message: "Project path is not allowed" });
    });
    const request = Effect.fn("RemoteBrowser.request")(function* (
      sessionId: string,
      workingDirectory: string,
      command: "enter" | "cdp" | "events",
      fields: {
        method?: string;
        params?: typeof jsonValueSchema.Type;
        methods?: ReadonlyArray<string>;
        limit?: number;
        clear?: boolean;
      },
    ) {
      yield* allowed(command, workingDirectory);
      const result = yield* requests
        .requestBrowserNative(
          sessionId,
          {
            operation: command,
            workspacePath: workingDirectory,
            ...fields,
          },
          new AbortController().signal,
        )
        .pipe(
          Effect.mapError(
            (error) => new BrowserError({ operation: command, message: error.message }),
          ),
        );
      const decoded = yield* Schema.decodeUnknownEffect(
        cakeRpcPayloadSchemas["respond-browser-native"].fields.result,
      )(result).pipe(
        Effect.mapError(
          (error) => new BrowserError({ operation: command, message: error.message }),
        ),
      );
      if (decoded.status === "failed")
        return yield* new BrowserError({ operation: command, message: decoded.message });
      return decoded;
    });
    return Browser.of({
      open: () => Effect.fail(unavailable("open")),
      state: () => Effect.fail(unavailable("state")),
      updateBounds: () => Effect.fail(unavailable("updateBounds")),
      navigate: () => Effect.fail(unavailable("navigate")),
      action: () => Effect.fail(unavailable("action")),
      inspect: () => Effect.fail(unavailable("inspect")),
      nativeEnter: () => Effect.fail(unavailable("nativeEnter")),
      nativeCdp: () => Effect.fail(unavailable("nativeCdp")),
      nativeEvents: () => Effect.fail(unavailable("nativeEvents")),
      enterProjectBrowser: Effect.fn("RemoteBrowser.enterProjectBrowser")(
        function* (sessionId, workingDirectory) {
          const result = yield* request(sessionId, workingDirectory, "enter", {});
          if (result.status !== "completed") return yield* unavailable("enterProjectBrowser");
        },
      ),
      sendProjectCdp: Effect.fn("RemoteBrowser.sendProjectCdp")(
        (sessionId, workingDirectory, method, params) =>
          request(sessionId, workingDirectory, "cdp", { method, params }),
      ),
      takeProjectCdpEvents: Effect.fn("RemoteBrowser.takeProjectCdpEvents")(
        (sessionId, workingDirectory, methods, limit, clear) =>
          request(sessionId, workingDirectory, "events", { methods, limit, clear }),
      ),
      closeForWindow: () => Effect.void,
    });
  }),
);
