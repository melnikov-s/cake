import { Schema } from "effect";

export class ElectronError extends Schema.TaggedError<ElectronError>()("ElectronError", {
  message: Schema.String,
}) {}
