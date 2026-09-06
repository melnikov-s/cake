import { Effect, Stream } from "effect";
import * as workingDirectoryTerminals from "../../domain/workingDirectoryTerminals";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { TerminalRpc } from "../protocol/TerminalRpc";

export const terminalHandlers = TerminalRpc.of({
  "terminals.open-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      workingDirectoryTerminals.open(connectionId, request),
    ),
  "terminals.get-terminal-status": (request) =>
    Effect.flatMap(RendererConnection, () => workingDirectoryTerminals.status(request)),
  "terminals.write-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      workingDirectoryTerminals.write(connectionId, request),
    ),
  "terminals.resize-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      workingDirectoryTerminals.resize(connectionId, request),
    ),
  "terminals.close-terminal": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      workingDirectoryTerminals.close(connectionId, request),
    ),
  "terminals.close-working-directory-terminals": (request) =>
    Effect.flatMap(RendererConnection, () =>
      workingDirectoryTerminals.closeWorkingDirectory(request),
    ),
  "terminals.observeEvents": () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* RendererConnection;
        const terminalEvents = yield* workingDirectoryTerminals.events(connection.connectionId);
        const nativeEvents = (yield* NativeEvents).terminals(connection.connectionId);
        return Stream.merge(terminalEvents, nativeEvents);
      }),
    ),
});
