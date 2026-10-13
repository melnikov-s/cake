import { Schema } from "effect";

export const artifactStateRequestEnvelope = Schema.Struct({
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
  type: Schema.Literals(["artifact-state-read", "artifact-state-replace"]),
  value: Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    value: Schema.optionalKey(Schema.Unknown),
  }),
});

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
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("artifact-state-read"),
    value: Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    }),
  }),
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("artifact-state-replace"),
    value: Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      value: Schema.Json,
    }),
  }),
  Schema.Struct({ ...inlineWidgetMessageBase, type: Schema.Literal("cancel") }),
]);
