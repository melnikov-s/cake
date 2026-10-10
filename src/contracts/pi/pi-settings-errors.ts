import { Schema } from "effect";

export class PiSettingsError extends Schema.TaggedError<PiSettingsError>()("PiSettingsError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
