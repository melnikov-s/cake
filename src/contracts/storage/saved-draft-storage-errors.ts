import { Schema } from "effect";

export class SavedDraftError extends Schema.TaggedError<SavedDraftError>()("SavedDraftError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
