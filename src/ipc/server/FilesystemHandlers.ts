import { Effect } from "effect";
import { WorkspaceFiles } from "../../services/filesystem/WorkspaceFiles";
import { NativeAttachments } from "../../services/filesystem/NativeAttachments";
import { NativeAttachmentsRpc } from "../protocol/NativeAttachmentsRpc";
import { FilesystemRpc } from "../protocol/FilesystemRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

export const nativeAttachmentsHandlers = NativeAttachmentsRpc.of({
  "filesystem.read-selected-file": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(NativeAttachments, (service) => service.readSelected(connectionId, request)),
    ),
  "filesystem.choose-attachments": () =>
    withConnection((connectionId) =>
      Effect.flatMap(NativeAttachments, (service) => service.choose(connectionId)),
    ),
});

export const filesystemHandlers = FilesystemRpc.of({
  "filesystem.suggest-files": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(WorkspaceFiles, (service) => service.suggestFiles(connectionId, request)),
    ),
  "filesystem.read-workspace-file": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(WorkspaceFiles, (service) => service.readFile(connectionId, request)),
    ),
  "filesystem.read-workspace-image": (request) =>
    withConnection((connectionId) =>
      Effect.flatMap(WorkspaceFiles, (service) => service.readImage(connectionId, request)),
    ),
});
