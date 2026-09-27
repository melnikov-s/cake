import { Context, Schema, type Effect } from "effect";
import type { Attachment } from "../../ipc/session-contract";

export class AttachmentUploadError extends Schema.TaggedError<AttachmentUploadError>()(
  "AttachmentUploadError",
  { operation: Schema.String, message: Schema.String },
) {}

/** Backend-owned temporary uploads; only admit resolves a token into Pi-ready bytes/paths. */
export class AttachmentUploads extends Context.Service<
  AttachmentUploads,
  {
    readonly open: (
      owner: number,
      input: { kind: "file" | "image"; name: string; mimeType?: string; size: number },
    ) => Effect.Effect<{ id: string }, AttachmentUploadError>;
    readonly chunk: (
      owner: number,
      input: { id: string; offset: number; data: string },
    ) => Effect.Effect<void, AttachmentUploadError>;
    readonly finish: (
      owner: number,
      id: string,
    ) => Effect.Effect<{ reference: string }, AttachmentUploadError>;
    readonly discard: (owner: number, id: string) => Effect.Effect<void>;
    readonly admit: (
      owner: number,
      attachments: ReadonlyArray<Attachment>,
    ) => Effect.Effect<ReadonlyArray<Attachment>, AttachmentUploadError>;
    readonly releaseConnection: (owner: number) => Effect.Effect<void>;
  }
>()("cake/services/filesystem/AttachmentUploads") {}

export const uploadReference = (id: string) => `cake-upload:${id}`;
export const uploadId = (value: string) =>
  /^cake-upload:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
    value,
  )?.[1];
