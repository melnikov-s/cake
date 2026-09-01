import { Schema } from "effect";

export class NativeOperationError extends Schema.TaggedError<NativeOperationError>()(
  "NativeOperationError",
  { message: Schema.String },
) {}
