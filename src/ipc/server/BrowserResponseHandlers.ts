import { Effect } from "effect";
import { BrowserResponseRpc } from "../protocol/BrowserRpc";
import {
  RendererConnection,
  RendererConnectionMiddleware,
} from "../protocol/RendererConnectionMiddleware";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { BrowserError } from "../../services/browser/Browser";

export const browserResponseHandlers = BrowserResponseRpc.middleware(
  RendererConnectionMiddleware,
).of({
  "browser.acquire-browser-preview": ({ sessionId, port }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      const coordinator = yield* RendererRequestCoordinator;
      return yield* coordinator
        .acquirePreview(connectionId, sessionId, port)
        .pipe(
          Effect.mapError(
            (error) => new BrowserError({ operation: "acquirePreview", message: error.message }),
          ),
        );
    }),
  "browser.respond-browser-native": ({ sessionId, requestId, result }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      const coordinator = yield* RendererRequestCoordinator;
      yield* coordinator
        .respondBrowserNative(connectionId, sessionId, requestId, result)
        .pipe(
          Effect.mapError(
            (error) =>
              new BrowserError({ operation: "respondBrowserNative", message: error.message }),
          ),
        );
      return {};
    }),
});
