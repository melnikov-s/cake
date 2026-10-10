import { Schema } from "effect";

export class TerminalError extends Schema.TaggedError<TerminalError>()("TerminalError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
