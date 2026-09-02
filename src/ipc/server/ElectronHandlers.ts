import { Effect, Stream } from "effect";
import { Electron } from "../../services/electron/Electron";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { ElectronRpc } from "../protocol/ElectronRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const electronHandlers = ElectronRpc.of({
  "electron.choose-project": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.chooseProject(connectionId, request)),
    ),
  "electron.open-external-url": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(Electron, (service) => service.openExternalUrl(connectionId, request)),
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
        return (yield* NativeEvents).surfaces(connection.connectionId);
      }),
    ),
});
