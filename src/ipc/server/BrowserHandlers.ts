import { Effect } from "effect";
import { Browser } from "../../services/browser/Browser";
import { BrowserRpc } from "../protocol/BrowserRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const browserHandlers = BrowserRpc.of({
  "browser.open-browser": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) => browser.open(connectionId, request)),
    ),
  "browser.get-browser-state": (request) =>
    Effect.flatMap(Browser, (browser) => browser.state(request.sessionId)),
  "browser.update-browser-bounds": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Browser, (browser) => browser.updateBounds(connectionId, request)),
    ),
  "browser.navigate-browser": (request) =>
    Effect.flatMap(Browser, (browser) => browser.navigate(request.sessionId, request.url)),
  "browser.browser-action": (request) =>
    Effect.flatMap(Browser, (browser) => browser.action(request.sessionId, request.action)),
  "browser.inspect-browser-element": (request) =>
    Effect.flatMap(Browser, (browser) => browser.inspect(request.sessionId)),
});
