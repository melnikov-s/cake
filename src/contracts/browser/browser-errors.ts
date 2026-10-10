import { Schema } from "effect";

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
