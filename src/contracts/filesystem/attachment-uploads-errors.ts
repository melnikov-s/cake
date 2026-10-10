import { Schema } from "effect";

export class AttachmentUploadError extends Schema.TaggedError<AttachmentUploadError>()(
  "AttachmentUploadError",
  { operation: Schema.String, message: Schema.String },
) {}
