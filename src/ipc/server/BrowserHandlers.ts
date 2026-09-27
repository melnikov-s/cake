import { Effect, Schema } from "effect";
import { jsonObjectSchema } from "../json-contract";
import { Browser, BrowserError } from "../../services/browser/Browser";
import { BrowserRpc } from "../protocol/BrowserRpc";
import {
  RendererConnection,
  RendererConnectionMiddleware,
} from "../protocol/RendererConnectionMiddleware";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const browserHandlers = BrowserRpc.middleware(RendererConnectionMiddleware).of({
  "browser.open-browser": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) => browser.open(connectionId, request)),
    ),
  "browser.get-browser-state": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) => browser.state(connectionId, request.sessionId)),
    ),
  "browser.update-browser-bounds": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) => browser.updateBounds(connectionId, request)),
    ),
  "browser.navigate-browser": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) =>
        browser.navigate(connectionId, request.sessionId, request.url),
      ),
    ),
  "browser.browser-action": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) =>
        browser.action(connectionId, request.sessionId, request.action),
      ),
    ),
  "browser.inspect-browser-element": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) => browser.inspect(connectionId, request.sessionId)),
    ),
  "browser.native-browser-enter": ({ sessionId, workspacePath }) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) =>
        browser.nativeEnter(connectionId, sessionId, workspacePath),
      ).pipe(Effect.as({})),
    ),
  "browser.native-browser-cdp": ({ sessionId, method, params }) =>
    withConnection((connectionId) =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const object = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(params).pipe(
          Effect.mapError(
            (error) => new BrowserError({ operation: "nativeCdp", message: error.message }),
          ),
        );
        return yield* browser.nativeCdp(connectionId, sessionId, method, object);
      }),
    ),
  "browser.native-browser-events": ({ sessionId, methods, limit, clear }) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) =>
        browser.nativeEvents(connectionId, sessionId, methods, limit, clear),
      ),
    ),
});
