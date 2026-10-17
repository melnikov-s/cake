import { Effect, Stream } from "effect";
import { Electron } from "../../services/electron/Electron";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { ElectronRpc } from "../protocol/ElectronRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const electronHandlers = ElectronRpc.of({
  "electron.configure-screen-capture": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.configureScreenCapture(id, request)),
    ),
  "electron.configure-cake-chat-overlay": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.configureCakeChatOverlay(id, request)),
    ),
  "electron.hide-cake-chat-overlay": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.hideCakeChatOverlay(id, request)),
    ),
  "electron.show-main-window": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.showMainWindow(id, request)),
    ),
  "electron.capture-widget-view": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.captureWidgetView(id, request)),
    ),
  "electron.start-screen-capture": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.startScreenCapture(id, request)),
    ),
  "electron.screen-capture-state": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.screenCaptureState(id, request)),
    ),
  "electron.finish-screen-capture": (request) =>
    withConnection((id) =>
      Effect.flatMap(Electron, (service) => service.finishScreenCapture(id, request)),
    ),
  "electron.choose-project": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.chooseProject(connectionId, request)),
    ),
  "electron.open-external-url": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.openExternalUrl(connectionId, request)),
    ),
  "electron.show-notification": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.showNotification(connectionId, request)),
    ),
  "electron.show-transcript-selection-context-menu": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) =>
        service.showTranscriptSelectionContextMenu(connectionId, request),
      ),
    ),
  "electron.show-composer-context-menu": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.showComposerContextMenu(connectionId, request)),
    ),
  "electron.show-session-context-menu": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.showSessionContextMenu(connectionId, request)),
    ),
  "electron.show-project-context-menu": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.showProjectContextMenu(connectionId, request)),
    ),
  "electron.set-fullscreen-surface-open": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) =>
        service.setFullscreenSurfaceOpen(connectionId, request),
      ),
    ),
  "electron.observeSurfaceEvents": () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* RendererConnection;
        return (yield* ClientEvents).surfaces(connection.connectionId);
      }),
    ),
});
