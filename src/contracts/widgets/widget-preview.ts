import { Schema } from "effect";

/** Initial-state capture retained in an immutable snapshot (reviewed generation or retained-output reuse). */
export const WidgetPreview = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_048_576),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
});

export interface WidgetPreview extends Schema.Schema.Type<typeof WidgetPreview> {}
