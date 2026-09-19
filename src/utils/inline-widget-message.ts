import { Schema } from "effect";

const inlineWidgetMessageBase = {
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
};

export const inlineWidgetMessageSchema = Schema.Union([
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("ready"),
    value: Schema.Boolean,
  }),
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("height"),
    value: Schema.Number,
  }),
  Schema.Struct({ ...inlineWidgetMessageBase, type: Schema.Literal("error"), value: Schema.Json }),
  Schema.Struct({ ...inlineWidgetMessageBase, type: Schema.Literal("submit"), value: Schema.Json }),
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("plugin-call"),
    value: Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      input: Schema.Record(Schema.String, Schema.Json),
    }),
  }),
  Schema.Struct({ ...inlineWidgetMessageBase, type: Schema.Literal("cancel") }),
]);
