import { Schema } from "effect";
import { WidgetEventSubscription, WidgetPollOptions } from "../contracts/widgets/widget-updates";

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

const subscriptionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const inlineWidgetMessageSchema = Schema.Union([
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("widget-subscribe"),
    value: Schema.Union([
      Schema.Struct({
        id: subscriptionId,
        subscriptionId,
        kind: Schema.Literal("event"),
        ...WidgetEventSubscription.fields,
      }),
      Schema.Struct({
        id: subscriptionId,
        subscriptionId,
        kind: Schema.Literal("poll"),
        options: WidgetPollOptions,
      }),
    ]),
  }),
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("widget-unsubscribe"),
    value: Schema.Struct({ subscriptionId }),
  }),
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("artifact-interaction"),
    value: Schema.Boolean,
  }),
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
    type: Schema.Literal("artifact-tool-call"),
    value: Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      input: Schema.Json,
    }),
  }),
  Schema.Struct({
    ...inlineWidgetMessageBase,
    type: Schema.Literal("artifact-cake-call"),
    value: Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      input: Schema.Json,
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

/** Read-aloud requests from inline and attached widgets. Long text is chunked by the host. */
export const inlineWidgetSpeechMessageSchema = Schema.Struct({
  ...inlineWidgetMessageBase,
  type: Schema.Literal("speech"),
  value: Schema.Union([
    Schema.Struct({
      action: Schema.Literal("speak"),
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      text: Schema.String.check(Schema.isMaxLength(500_000)),
      from: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
    Schema.Struct({ action: Schema.Literals(["pause", "resume", "stop"]) }),
  ]),
});
