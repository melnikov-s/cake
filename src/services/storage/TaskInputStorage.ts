import { Context, type Effect } from "effect";
import type {
  AttachmentContent,
  AttachmentReadInput,
  AttachmentReferenceQuery,
} from "../../contracts/conversations/attachment-reference-control";
import type { Attachment } from "../../contracts/conversations/session-contract";
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
    /** Bind explicit grants without opening the attachment payloads. */
    readonly grant: (
      recipientSessionId: string,
      references: readonly string[],
    ) => Effect.Effect<readonly TaskInputReference[], AttachmentUploadError>;
    readonly list: (
      sessionId: string,
      query: AttachmentReferenceQuery,
    ) => Effect.Effect<
      { readonly references: readonly TaskInputReference[]; readonly nextAfter: string | null },
      AttachmentUploadError
    >;
    readonly inspect: (
      sessionId: string,
      input: AttachmentReadInput,
    ) => Effect.Effect<AttachmentContent, AttachmentUploadError>;
    readonly isRecipient: (sessionId: string) => Effect.Effect<boolean, AttachmentUploadError>;
    readonly protectRecipient: (sessionId: string) => Effect.Effect<void, AttachmentUploadError>;
  }
>()("cake/services/storage/TaskInputStorage") {}
