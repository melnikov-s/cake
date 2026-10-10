import { Schema } from "effect";

export class SessionFamilyStorageError extends Schema.TaggedError<SessionFamilyStorageError>()(
  "SessionFamilyStorageError",
  { operation: Schema.String, message: Schema.String },
) {}
