import { Schema } from "effect";

export class ManagedWorktreeError extends Schema.TaggedError<ManagedWorktreeError>()(
  "ManagedWorktreeError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
