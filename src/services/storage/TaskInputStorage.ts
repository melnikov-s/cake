import { Context, type Effect } from "effect";
import type { Attachment } from "../../ipc/session-contract";
import type { TaskInputReference } from "../../contracts/conversations/task-input";
import type { AttachmentUploadError } from "../../contracts/filesystem/attachment-uploads-errors";

/** Single-user backend input vault. References are not read capabilities. */
export class TaskInputStorage extends Context.Service<
  TaskInputStorage,
  {
    readonly isolate: (
      ownerSessionId: string,
      attachments: readonly Attachment[],
    ) => Effect.Effect<readonly TaskInputReference[], AttachmentUploadError>;
    readonly authorizeForward: (
      ownerSessionId: string,
      ids: readonly string[],
      targetSessionId?: string,
    ) => Effect.Effect<readonly string[], AttachmentUploadError>;
    readonly resolve: (
      recipientSessionId: string,
      attachments: readonly Attachment[],
    ) => Effect.Effect<readonly Attachment[], AttachmentUploadError>;
    readonly isRecipient: (sessionId: string) => Effect.Effect<boolean, AttachmentUploadError>;
    readonly protectRecipient: (sessionId: string) => Effect.Effect<void, AttachmentUploadError>;
  }
>()("cake/services/storage/TaskInputStorage") {}
