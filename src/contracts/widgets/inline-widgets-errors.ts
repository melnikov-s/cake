import { Schema } from "effect";

export class InlineWidgetError extends Schema.TaggedError<InlineWidgetError>()(
  "InlineWidgetError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
