import { Effect, Stream } from "effect";
import { VsCodeViews } from "../../services/vscode/VsCodeViews";
import { ClientConnections } from "../../services/clients/ClientConnections";
import * as embeddedEditor from "../../domain/application/embeddedEditor";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { VsCodeRpc, VsCodeViewRpc } from "../protocol/VsCodeRpc";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const vscodeViewHandlers = VsCodeViewRpc.of({
  "vscodeViews.observeEvents": () =>
    Stream.unwrap(withConnection((id) => Effect.map(ClientEvents, (events) => events.vscode(id)))),
  "vscodeViews.preferredTheme": () =>
    Effect.flatMap(VsCodeViews, (views) => views.preferredTheme()),
  "vscodeViews.open": (request) => withConnection((id) => embeddedEditor.present(id, request)),
  "vscodeViews.updateBounds": (request) =>
    withConnection((id) => Effect.flatMap(VsCodeViews, (views) => views.updateBounds(id, request))),
  "vscodeViews.close": () =>
    withConnection((id) =>
      Effect.gen(function* () {
        const nativeId = (yield* ClientConnections).nativeId(id);
        if (nativeId !== undefined) yield* (yield* VsCodeViews).closeForWindow(nativeId);
      }),
    ),
  "vscodeViews.focusCake": () =>
    withConnection((id) => Effect.flatMap(VsCodeViews, (views) => views.focusCake(id))),
  "vscodeViews.observeThemes": () =>
    Stream.unwrap(
      withConnection((id) =>
        Effect.map(VsCodeViews, (views) =>
          views.themeChanges().pipe(
            Stream.filter((event) => event.connectionId === id),
            Stream.map((event) => event.theme),
          ),
        ),
      ),
    ),
});

export const vscodeHandlers = VsCodeRpc.of({
  "vscode.acquire": (request) => withConnection((id) => embeddedEditor.acquire(id, request)),
  "vscode.release": (request) =>
    withConnection((id) =>
      Effect.flatMap(VsCodeServer, (server) => server.releaseLease(id, request.leaseId)),
    ),
  "vscode.setVisible": (request) =>
    withConnection((id) =>
      Effect.flatMap(VsCodeServer, (server) => server.setVisible(id, request.visible)),
    ),
  "vscode.setTheme": (request) =>
    withConnection((id) =>
      Effect.flatMap(VsCodeServer, (server) => server.setTheme(id, request.theme)),
    ),
  "vscode.get-embedded-editor-state": () =>
    Effect.flatMap(VsCodeServer, (service) => service.state()),
  "vscode.observeState": () =>
    Stream.unwrap(Effect.map(VsCodeServer, (service) => service.stateChanges())),
  "vscode.set-vscode-server-path": (request) =>
    embeddedEditor.setServerPath(request.path).pipe(Effect.map((state) => ({ state }))),
  "vscode.install-embedded-editor": (request) =>
    Effect.flatMap(VsCodeServer, (service) => service.install(request)),
  "vscode.reveal-in-embedded-editor": (request) =>
    withConnection((id) => Effect.flatMap(VsCodeServer, (service) => service.reveal(id, request))),
  "vscode.open-embedded-editor-source-control": (request) =>
    withConnection((id) =>
      Effect.flatMap(VsCodeServer, (service) => service.openSourceControl(id, request)),
    ),
  "vscode.perform-embedded-editor-action": (request) =>
    withConnection((id) =>
      Effect.flatMap(VsCodeServer, (service) => service.performEditorAction(id, request)),
    ),
  "vscode.update-embedded-editor-selection-highlights": (request) =>
    withConnection((id) =>
      Effect.flatMap(VsCodeServer, (service) => service.updateSelectionHighlights(id, request)),
    ),
  "vscode.update-embedded-editor-annotations": (request) =>
    withConnection((id) =>
      Effect.flatMap(VsCodeServer, (service) => service.updateAnnotations(id, request)),
    ),
  "vscode.observeEvents": () =>
    Stream.unwrap(withConnection((id) => Effect.map(ClientEvents, (events) => events.vscode(id)))),
});
