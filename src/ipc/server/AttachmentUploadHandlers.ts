import { Effect } from "effect";
import type { Attachment } from "../session-contract";
import { AttachmentUploads } from "../../services/filesystem/AttachmentUploads";
import { AttachmentUploadRpc } from "../protocol/AttachmentUploadRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const withOwner = <A, E, R>(
  operation: (owner: number, uploads: typeof AttachmentUploads.Service) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) =>
    Effect.flatMap(AttachmentUploads, (uploads) => operation(connectionId, uploads)),
  );

export const attachmentUploadHandlers = AttachmentUploadRpc.of({
  "attachmentUploads.open": (input) => withOwner((owner, uploads) => uploads.open(owner, input)),
  "attachmentUploads.chunk": (input) => withOwner((owner, uploads) => uploads.chunk(owner, input)),
  "attachmentUploads.finish": ({ id }) => withOwner((owner, uploads) => uploads.finish(owner, id)),
  "attachmentUploads.discard": ({ id }) =>
    withOwner((owner, uploads) => uploads.discard(owner, id)),
});

/** Shared admission for all user-turn mutations; tokens never escape to the Pi runtime. */
export const admitTurnAttachments = <A extends { readonly attachments: ReadonlyArray<Attachment> }>(
  input: A,
) =>
  withOwner((owner, uploads) =>
    Effect.map(uploads.admit(owner, input.attachments), (attachments) => ({
      ...input,
      attachments,
    })),
  );
