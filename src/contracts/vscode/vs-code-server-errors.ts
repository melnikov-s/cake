import { Schema } from "effect";

export class VsCodeServerError extends Schema.TaggedError<VsCodeServerError>()(
  "VsCodeServerError",
  { operation: Schema.String, message: Schema.String },
) {}
