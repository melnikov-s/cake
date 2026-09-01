import { Schema } from "effect";

const inlineWidgetMessageBase = {
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
};

export const inlineWidgetMessageSchema = Schema.Union([
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("height"),
    value: Schema.Number,
  }),
  Schema.Struct({ ...inlineWidgetMessageBase, type: Schema.Literal("error"), value: Schema.Json }),
  Schema.Struct({ ...inlineWidgetMessageBase, type: Schema.Literal("submit"), value: Schema.Json }),
  Schema.Struct({ ...inlineWidgetMessageBase, type: Schema.Literal("cancel") }),
]);

export function inlineWidgetRepairContext(context: string, instructions: string) {
  return `${context}\n\nUser's requested repair:\n${instructions}`;
}
