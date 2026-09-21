import { Context, Schema, type Effect } from "effect";
import type { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../../ipc/cake-rpc-contract";

export class WorkspaceFileError extends Schema.TaggedError<WorkspaceFileError>()(
  "WorkspaceFileError",
  { operation: Schema.String, message: Schema.String },
) {}

type FilesystemOperation =
  | "choose-attachments"
  | "suggest-files"
  | "read-workspace-file"
  | "read-workspace-image";
type Payload<Type extends FilesystemOperation> = (typeof cakeRpcPayloadSchemas)[Type]["Type"];
type Success<Type extends FilesystemOperation> = (typeof cakeRpcSuccessSchemas)[Type]["Type"];

export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    readonly chooseAttachments: (
      connectionId: number,
      request: Payload<"choose-attachments">,
    ) => Effect.Effect<Success<"choose-attachments">, WorkspaceFileError>;
    readonly suggestFiles: (
      connectionId: number,
      request: Payload<"suggest-files">,
    ) => Effect.Effect<Success<"suggest-files">, WorkspaceFileError>;
    readonly readFile: (
      connectionId: number,
      request: Payload<"read-workspace-file">,
    ) => Effect.Effect<Success<"read-workspace-file">, WorkspaceFileError>;
    readonly readImage: (
      connectionId: number,
      request: Payload<"read-workspace-image">,
    ) => Effect.Effect<Success<"read-workspace-image">, WorkspaceFileError>;
  }
>()("cake/services/filesystem/WorkspaceFiles") {}
