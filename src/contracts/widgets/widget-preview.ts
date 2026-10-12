import { Schema } from "effect";

/** The accepted review capture, retained as part of an immutable artifact snapshot. */
export const WidgetPreview = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_048_576),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
});

export interface WidgetPreview extends Schema.Schema.Type<typeof WidgetPreview> {}
