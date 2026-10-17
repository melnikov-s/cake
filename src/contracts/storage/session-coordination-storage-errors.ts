import { Schema } from "effect";

export class SessionCoordinationStorageError extends Schema.TaggedError<SessionCoordinationStorageError>()(
  "SessionCoordinationStorageError",
  { operation: Schema.String, message: Schema.String },
) {}
