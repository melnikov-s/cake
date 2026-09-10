import { Schema } from "effect";
import { ThinkingLevel } from "../../services/pi/model-data";

const nonEmptyBoundedString = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const boundedString = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));

export const SubagentHandleId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("SubagentHandleId"),
);
export type SubagentHandleId = Schema.Schema.Type<typeof SubagentHandleId>;

export const SubagentStatus = Schema.Literals([
  "queued",
  "running",
  "complete",
  "error",
  "aborted",
]);
export type SubagentStatus = Schema.Schema.Type<typeof SubagentStatus>;

export const AgentModelPreference = Schema.Union([
  Schema.Struct({ prefer: Schema.Literal("utility") }),
  Schema.Struct({ prefer: Schema.Literal("default") }),
  Schema.Struct({ prefer: Schema.Literal("current") }),
  Schema.Struct({
    prefer: Schema.Literal("exact"),
    provider: nonEmptyBoundedString(256),
    modelId: nonEmptyBoundedString(512),
    thinkingLevel: Schema.optionalKey(ThinkingLevel),
  }),
]);
export type AgentModelPreference = Schema.Schema.Type<typeof AgentModelPreference>;

const AgentModelFallback = Schema.Struct({
  source: Schema.Literals(["utility", "default", "current"]),
  reason: Schema.Literals(["not-configured", "unknown-model", "not-authenticated"]),
});
interface AgentModelFallback extends Schema.Schema.Type<typeof AgentModelFallback> {}

export const ResolvedAgentModel = Schema.Struct({
  requested: Schema.Literals(["utility", "default", "current", "exact"]),
  source: Schema.Literals(["utility", "default", "current", "exact"]),
  provider: nonEmptyBoundedString(256),
  modelId: nonEmptyBoundedString(512),
  thinkingLevel: ThinkingLevel,
  fallbacks: Schema.Array(AgentModelFallback).check(Schema.isMaxLength(3)),
});
export interface ResolvedAgentModel extends Schema.Schema.Type<typeof ResolvedAgentModel> {}

export const SubagentTaskInput = Schema.Struct({
  task: nonEmptyBoundedString(262_144),
  model: Schema.optionalKey(AgentModelPreference),
  instructions: Schema.optionalKey(boundedString(32_768)),
  fastMode: Schema.optionalKey(Schema.Boolean),
});
export interface SubagentTaskInput extends Schema.Schema.Type<typeof SubagentTaskInput> {}

export const SubagentTask = Schema.Struct({
  task: SubagentTaskInput.fields.task,
  model: AgentModelPreference,
  instructions: Schema.optionalKey(boundedString(32_768)),
  fastMode: Schema.Boolean,
});
export interface SubagentTask extends Schema.Schema.Type<typeof SubagentTask> {}

export const ParallelSubagentInput = Schema.Struct({
  tasks: Schema.Array(SubagentTaskInput).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export interface ParallelSubagentInput extends Schema.Schema.Type<typeof ParallelSubagentInput> {}

export const SubagentParent = Schema.Struct({
  parentSessionId: nonEmptyBoundedString(256),
});
export interface SubagentParent extends Schema.Schema.Type<typeof SubagentParent> {}

export const SubagentActivity = Schema.Struct({
  parentSessionId: SubagentParent.fields.parentSessionId,
  anchorPartId: nonEmptyBoundedString(256),
  handleId: SubagentHandleId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  task: SubagentTask.fields.task,
  status: SubagentStatus,
  resolvedModel: ResolvedAgentModel,
  fastMode: Schema.Boolean,
  streaming: Schema.Boolean,
  parts: Schema.Array(Schema.Json).check(Schema.isMaxLength(10_000)),
  usage: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(boundedString(16_384)),
});
export interface SubagentActivity extends Schema.Schema.Type<typeof SubagentActivity> {}

export const SubagentResult = Schema.Struct({
  handleId: SubagentHandleId,
  task: SubagentTask.fields.task,
  status: SubagentStatus,
  resolvedModel: ResolvedAgentModel,
  fastMode: Schema.Boolean,
  streaming: Schema.Boolean,
  parts: Schema.Array(Schema.Json).check(Schema.isMaxLength(10_000)),
  usage: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(boundedString(16_384)),
});
export interface SubagentResult extends Schema.Schema.Type<typeof SubagentResult> {}

export const SubagentStartReceipt = Schema.Struct({
  handleId: SubagentHandleId,
  task: SubagentTask.fields.task,
  status: SubagentStatus,
  fastMode: Schema.Boolean,
  resolvedModel: ResolvedAgentModel,
});
export interface SubagentStartReceipt extends Schema.Schema.Type<typeof SubagentStartReceipt> {}

export const SubagentUpdate = Schema.TaggedUnion({
  Snapshot: {
    revision: Schema.Int,
    parentSessionId: SubagentParent.fields.parentSessionId,
    activities: Schema.Array(SubagentActivity),
    backgroundActive: Schema.Boolean,
  },
  Activity: {
    revision: Schema.Int,
    parentSessionId: SubagentParent.fields.parentSessionId,
    activity: SubagentActivity,
  },
  Removed: {
    revision: Schema.Int,
    parentSessionId: SubagentParent.fields.parentSessionId,
    handleId: SubagentHandleId,
  },
  Background: {
    revision: Schema.Int,
    parentSessionId: SubagentParent.fields.parentSessionId,
    active: Schema.Boolean,
  },
});
export type SubagentUpdate = Schema.Schema.Type<typeof SubagentUpdate>;

export class SubagentError extends Schema.TaggedError<SubagentError>()("SubagentError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
