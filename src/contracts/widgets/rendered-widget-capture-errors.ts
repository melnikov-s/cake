import { Schema } from "effect";

export class RenderedWidgetCaptureError extends Schema.TaggedError<RenderedWidgetCaptureError>()(
  "RenderedWidgetCaptureError",
  { kind: Schema.Literals(["widget", "cancelled", "infrastructure"]), message: Schema.String },
) {}
