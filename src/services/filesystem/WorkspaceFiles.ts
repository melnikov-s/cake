import { Context, type Effect } from "effect";
import type {
  nativeOperationPayloadSchemas,
  nativeOperationSuccessSchemas,
} from "../../ipc/native-protocol";
import type { NativeOperationError } from "../../ipc/protocol/NativeOperationError";

type Payload<Type extends "choose-attachments" | "suggest-files" | "read-workspace-file"> =
  (typeof nativeOperationPayloadSchemas)[Type]["Type"];
type Success<Type extends "choose-attachments" | "suggest-files" | "read-workspace-file"> =
  (typeof nativeOperationSuccessSchemas)[Type]["Type"];

export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    readonly chooseAttachments: (
      connectionId: number,
      request: Payload<"choose-attachments">,
    ) => Effect.Effect<Success<"choose-attachments">, NativeOperationError>;
    readonly suggestFiles: (
      connectionId: number,
      request: Payload<"suggest-files">,
    ) => Effect.Effect<Success<"suggest-files">, NativeOperationError>;
    readonly readFile: (
      connectionId: number,
      request: Payload<"read-workspace-file">,
    ) => Effect.Effect<Success<"read-workspace-file">, NativeOperationError>;
  }
>()("cake/services/filesystem/WorkspaceFiles") {}
