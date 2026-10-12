import { Schema } from "effect";
import {
  CakeModelSelection,
  ExplicitCakeModelSelection,
} from "../model-presets/cake-model-selection";
import { sessionUsageSchema, uiPartSchema } from "../conversations/session-contract";
import { jsonObjectSchema } from "../serialization/json-contract";

const nonEmpty = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const isoTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);

export const WorkflowRunId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("WorkflowRunId"),
);
export type WorkflowRunId = Schema.Schema.Type<typeof WorkflowRunId>;

export const WorkflowStepId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("WorkflowStepId"),
);
export type WorkflowStepId = Schema.Schema.Type<typeof WorkflowStepId>;

/** Run states describe Cake's scheduler, not the owning Project Session's Pi turn. */
const WorkflowRunStatusSchema = Schema.Literals([
  "running",
  "paused",
  "stopping",
  "stopped",
  "complete",
  "error",
  "interrupted",
]);

const WorkflowStepStatusSchema = Schema.Literals([
  "queued",
  "running",
  "complete",
  "error",
  "aborted",
]);

/** A JSON Schema document. This shape alone does not validate an agent's answer. */
export const WorkflowOutputSchema = Schema.Union([Schema.Boolean, jsonObjectSchema]);
export type WorkflowOutputSchema = Schema.Schema.Type<typeof WorkflowOutputSchema>;

export const WorkflowMeta = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}$/)),
  description: nonEmpty(4_096),
  phases: Schema.optionalKey(Schema.Array(nonEmpty(256)).check(Schema.isMaxLength(1_000))),
});
export interface WorkflowMeta extends Schema.Schema.Type<typeof WorkflowMeta> {}

const WorkflowAgentOptionsSchema = Schema.Struct({
  label: Schema.optionalKey(nonEmpty(256)),
  instructions: Schema.optionalKey(nonEmpty(32_768)),
  model: Schema.optionalKey(CakeModelSelection),
  schema: Schema.optionalKey(WorkflowOutputSchema),
  stallMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export const WorkflowAgentInput = Schema.Struct({
  prompt: nonEmpty(262_144),
  options: WorkflowAgentOptionsSchema,
});
export interface WorkflowAgentInput extends Schema.Schema.Type<typeof WorkflowAgentInput> {}

/** Frozen at launch. Editing the source file does not mutate a running program. */
export const WorkflowProgram = Schema.Struct({
  meta: WorkflowMeta,
  source: nonEmpty(1_048_576),
  sourcePath: nonEmpty(4_096),
  args: Schema.optionalKey(Schema.Json),
});
export interface WorkflowProgram extends Schema.Schema.Type<typeof WorkflowProgram> {}

/** Transient execution choice. Source and metadata are frozen before presentation. */
export const WorkflowProposal = Schema.Struct({
  ownerSessionId: nonEmpty(256),
  program: WorkflowProgram,
});
export interface WorkflowProposal extends Schema.Schema.Type<typeof WorkflowProposal> {}

/** A Project Session is the execution owner; Cake Chat can target it, not itself. */
export const WorkflowOwner = Schema.Struct({ sessionId: nonEmpty(256) });
export interface WorkflowOwner extends Schema.Schema.Type<typeof WorkflowOwner> {}

export const WorkflowStartInput = Schema.Struct({
  ...WorkflowOwner.fields,
  scriptPath: nonEmpty(4_096),
  args: Schema.optionalKey(Schema.Json),
});
export interface WorkflowStartInput extends Schema.Schema.Type<typeof WorkflowStartInput> {}

export const WorkflowRunTarget = Schema.Struct({
  ...WorkflowOwner.fields,
  runId: WorkflowRunId,
});
export interface WorkflowRunTarget extends Schema.Schema.Type<typeof WorkflowRunTarget> {}

export const WorkflowRelaunchInput = Schema.Struct({
  ...WorkflowRunTarget.fields,
  /** Omit to replay the frozen program; supply to deliberately use revised source. */
  scriptPath: Schema.optionalKey(nonEmpty(4_096)),
});
export interface WorkflowRelaunchInput extends Schema.Schema.Type<typeof WorkflowRelaunchInput> {}

export const WorkflowWorkerTarget = Schema.Struct({
  ...WorkflowRunTarget.fields,
  stepId: WorkflowStepId,
  /** Replay/relaunch pass; rejects late controls/activity from an earlier execution. */
  execution: Schema.Int.check(Schema.isGreaterThan(0)),
});
export interface WorkflowWorkerTarget extends Schema.Schema.Type<typeof WorkflowWorkerTarget> {}

export const WorkflowStep = Schema.Struct({
  id: WorkflowStepId,
  ordinal: nonNegative,
  execution: WorkflowWorkerTarget.fields.execution,
  phase: Schema.optionalKey(nonEmpty(256)),
  input: WorkflowAgentInput,
  workingDirectory: nonEmpty(4_096),
  status: WorkflowStepStatusSchema,
  /** Attempts include automatic stall retries and manual restarts; maximum six. */
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
  resolvedModel: ExplicitCakeModelSelection,
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(nonEmpty(16_384)),
  usage: Schema.optionalKey(sessionUsageSchema),
});
export interface WorkflowStep extends Schema.Schema.Type<typeof WorkflowStep> {}

/** No Pi transcript identity or duplicated transcript payload in a run record. */
export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  ownerSessionId: WorkflowOwner.fields.sessionId,
  projectPath: nonEmpty(4_096),
  workingDirectory: nonEmpty(4_096),
  program: WorkflowProgram,
  status: WorkflowRunStatusSchema,
  revision: nonNegative,
  execution: WorkflowWorkerTarget.fields.execution,
  /** Cumulative billed usage, including attempts from previous relaunches. */
  usage: Schema.optionalKey(sessionUsageSchema),
  maxConcurrentAgents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  phases: Schema.Array(nonEmpty(256)).check(Schema.isMaxLength(1_000)),
  logs: Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(
    Schema.isMaxLength(1_000),
  ),
  steps: Schema.Array(WorkflowStep).check(Schema.isMaxLength(1_000)),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(nonEmpty(16_384)),
});
export interface WorkflowRun extends Schema.Schema.Type<typeof WorkflowRun> {}

/** Derived on demand/live from Pi; not saved as a Cake transcript. */
export const WorkflowWorkerActivity = Schema.Struct({
  stepId: WorkflowStepId,
  execution: WorkflowWorkerTarget.fields.execution,
  attempt: WorkflowStep.fields.attempt,
  streaming: Schema.Boolean,
  parts: Schema.Array(uiPartSchema).check(Schema.isMaxLength(10_000)),
  usage: Schema.optionalKey(sessionUsageSchema),
});
export interface WorkflowWorkerActivity extends Schema.Schema.Type<typeof WorkflowWorkerActivity> {}

export const WorkflowRunReceipt = Schema.Struct({
  ...WorkflowRunTarget.fields,
  name: WorkflowMeta.fields.name,
  status: WorkflowRunStatusSchema,
});
export interface WorkflowRunReceipt extends Schema.Schema.Type<typeof WorkflowRunReceipt> {}

/** Compact card/tool data; intermediate answers and source stay in run detail. */
export const WorkflowRunSummary = Schema.Struct({
  id: WorkflowRunId,
  ownerSessionId: WorkflowOwner.fields.sessionId,
  meta: WorkflowMeta,
  status: WorkflowRunStatusSchema,
  revision: nonNegative,
  total: nonNegative,
  queued: nonNegative,
  active: nonNegative,
  complete: nonNegative,
  failed: nonNegative,
  aborted: nonNegative,
  phase: Schema.optionalKey(nonEmpty(256)),
  usage: Schema.optionalKey(sessionUsageSchema),
  error: Schema.optionalKey(nonEmpty(16_384)),
});
export interface WorkflowRunSummary extends Schema.Schema.Type<typeof WorkflowRunSummary> {}

export const WorkflowCatalogUpdate = Schema.TaggedUnion({
  Snapshot: {
    revision: nonNegative,
    ownerSessionId: WorkflowOwner.fields.sessionId,
    runs: Schema.Array(WorkflowRunSummary),
  },
  RunChanged: { revision: nonNegative, run: WorkflowRunSummary },
});
export type WorkflowCatalogUpdate = Schema.Schema.Type<typeof WorkflowCatalogUpdate>;

export const WorkflowRunUpdate = Schema.TaggedUnion({
  Snapshot: { revision: nonNegative, run: WorkflowRun },
  RunChanged: { revision: nonNegative, run: WorkflowRun },
  WorkerActivity: { revision: nonNegative, activity: WorkflowWorkerActivity },
});
export type WorkflowRunUpdate = Schema.Schema.Type<typeof WorkflowRunUpdate>;

export const SavedWorkflow = Schema.Struct({
  meta: WorkflowMeta,
  path: nonEmpty(4_096),
  location: Schema.Literals(["project", "personal"]),
});
export interface SavedWorkflow extends Schema.Schema.Type<typeof SavedWorkflow> {}

export const WorkflowSaveInput = Schema.Struct({
  ...WorkflowRunTarget.fields,
  name: WorkflowMeta.fields.name,
  location: SavedWorkflow.fields.location,
});
export interface WorkflowSaveInput extends Schema.Schema.Type<typeof WorkflowSaveInput> {}

export class WorkflowError extends Schema.TaggedError<WorkflowError>()("WorkflowError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "not-implemented",
    "not-found",
    "invalid-input",
    "invalid-state",
    "limit",
    "worker",
    "stalled",
    "invalid-output",
    "script",
    "sandbox",
    "storage",
  ]),
  message: Schema.String,
}) {}
