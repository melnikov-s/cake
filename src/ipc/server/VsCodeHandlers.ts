import { Effect, Stream } from "effect";
import * as embeddedEditor from "../../domain/application/embeddedEditor";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { VsCodeRpc } from "../protocol/VsCodeRpc";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const vscodeHandlers = VsCodeRpc.of({
  "vscode.get-embedded-editor-state": () =>
    Effect.flatMap(VsCodeServer, (service) => service.state()),
  "vscode.observeState": () =>
    Stream.unwrap(Effect.map(VsCodeServer, (service) => service.stateChanges())),
  "vscode.set-vscode-server-path": (request) =>
    embeddedEditor.setServerPath(request.path).pipe(Effect.map((state) => ({ state }))),
  "vscode.install-embedded-editor": (request) =>
    Effect.flatMap(VsCodeServer, (service) => service.install(request)),
  "vscode.open-embedded-editor": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(VsCodeServer, (service) => service.open(connectionId, request)),
    ),
  "vscode.update-embedded-editor-bounds": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(VsCodeServer, (service) => service.updateBounds(connectionId, request)),
    ),
  "vscode.reveal-in-embedded-editor": (request) =>
    Effect.flatMap(VsCodeServer, (service) => service.reveal(request)),
  "vscode.open-embedded-editor-source-control": (request) =>
    Effect.flatMap(VsCodeServer, (service) => service.openSourceControl(request)),
  "vscode.update-embedded-editor-annotations": (request) =>
    Effect.flatMap(VsCodeServer, (service) => service.updateAnnotations(request)),
  "vscode.observeEvents": () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* RendererConnection;
        return (yield* NativeEvents).vscode(connection.connectionId);
      }),
    ),
});
