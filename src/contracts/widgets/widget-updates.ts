import { Schema } from "effect";
import { ArtifactLineageId } from "../artifacts/artifact-lineage";
import { jsonObjectSchema } from "../serialization/json-contract";

const WidgetEventTopic = Schema.Literals([
  "session.changed",
  "session.transcript.changed",
  "session.removed",
  "artifact.execution.changed",
]);
const WidgetEventFilter = Schema.Struct({
  sessionId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  lineageId: Schema.optionalKey(ArtifactLineageId),
});
export const WidgetEventSubscription = Schema.Struct({
  topic: WidgetEventTopic,
  filter: WidgetEventFilter,
});
export type WidgetEventSubscription = typeof WidgetEventSubscription.Type;

export const WidgetPollOptions = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  input: jsonObjectSchema,
  intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 })),
});
export type WidgetPollOptions = typeof WidgetPollOptions.Type;

export const WidgetPollRequest = Schema.Struct({
  lineageId: ArtifactLineageId,
  sessionId: Schema.optionalKey(Schema.String),
  options: WidgetPollOptions,
});
export type WidgetPollRequest = typeof WidgetPollRequest.Type;

export const WidgetEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), topic: WidgetEventTopic }),
  Schema.Struct({
    kind: Schema.Literal("change"),
    topic: Schema.Literals(["session.changed", "session.transcript.changed", "session.removed"]),
    sessionId: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("change"),
    topic: Schema.Literal("artifact.execution.changed"),
    lineageId: ArtifactLineageId,
  }),
]);
export type WidgetEvent = typeof WidgetEvent.Type;

export const WidgetUpdate = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Json }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type WidgetUpdate = typeof WidgetUpdate.Type;
