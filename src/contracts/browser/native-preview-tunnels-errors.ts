import { Schema } from "effect";

export class NativePreviewError extends Schema.TaggedError<NativePreviewError>()(
  "NativePreviewError",
  { message: Schema.String },
) {}
