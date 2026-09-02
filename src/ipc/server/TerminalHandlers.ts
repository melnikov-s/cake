import { Effect, Stream } from "effect";
import * as sessionTerminals from "../../domain/sessionTerminals";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { TerminalRpc } from "../protocol/TerminalRpc";

export const terminalHandlers = TerminalRpc.of({
  "terminals.open-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      sessionTerminals.open(connectionId, request),
    ),
  "terminals.get-terminal-status": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      sessionTerminals.status(connectionId, request),
    ),
  "terminals.write-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      sessionTerminals.write(connectionId, request),
    ),
  "terminals.resize-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      sessionTerminals.resize(connectionId, request),
    ),
  "terminals.close-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      sessionTerminals.close(connectionId, request),
    ),
  "terminals.observeEvents": () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* RendererConnection;
        const terminalEvents = yield* sessionTerminals.events(connection.connectionId);
        const nativeEvents = (yield* NativeEvents).terminals(connection.connectionId);
        return Stream.merge(terminalEvents, nativeEvents);
      }),
    ),
});
