import { Schema } from "effect";
import { AgentListInput } from "../agent/agent-list-data";
import {
  Automation,
  AutomationActivity,
  AutomationDefinition,
  AutomationId,
  AutomationOccurrence,
  AutomationOccurrenceId,
  AutomationRun,
  AutomationRunId,
  AutomationSessionSummary,
  AutomationSummary,
} from "./automation-data";

export const AutomationTarget = Schema.Struct({ automationId: AutomationId });
export interface AutomationTarget extends Schema.Schema.Type<typeof AutomationTarget> {}
export const AutomationRunTarget = Schema.Struct({ runId: AutomationRunId });
export interface AutomationRunTarget extends Schema.Schema.Type<typeof AutomationRunTarget> {}
export const AutomationOccurrenceTarget = Schema.Struct({ occurrenceId: AutomationOccurrenceId });
export interface AutomationOccurrenceTarget extends Schema.Schema.Type<
  typeof AutomationOccurrenceTarget
> {}

export const AutomationCreateInput = Schema.Struct({
  definition: AutomationDefinition,
  initialState: Schema.Literals(["active", "paused"]),
});
export interface AutomationCreateInput extends Schema.Schema.Type<typeof AutomationCreateInput> {}
export const AutomationUpdateInput = Schema.Struct({
  ...AutomationTarget.fields,
  definition: AutomationDefinition,
});
export interface AutomationUpdateInput extends Schema.Schema.Type<typeof AutomationUpdateInput> {}
export const AutomationArchiveInput = Schema.Struct({
  ...AutomationTarget.fields,
  runningSessions: Schema.Literals(["let-finish", "stop"]),
});
export interface AutomationArchiveInput extends Schema.Schema.Type<typeof AutomationArchiveInput> {}

/** Run now is allowed while paused, never implicitly activates, and respects overlap. */
export const AutomationTriggerResult = Schema.TaggedUnion({
  started: {
    occurrenceId: AutomationOccurrenceId,
    runId: AutomationRunId,
    sessionId: Schema.String,
  },
  queued: { occurrenceId: AutomationOccurrenceId },
  skipped: { occurrenceId: AutomationOccurrenceId, reason: Schema.String },
  blocked: { occurrenceId: AutomationOccurrenceId, reason: Schema.String },
});
export type AutomationTriggerResult = typeof AutomationTriggerResult.Type;

/** Omit automationId for one globally ordered, bounded occurrence page. Query matches captured names. */
export const AutomationHistoryInput = Schema.Struct({
  automationId: Schema.optionalKey(AutomationId),
  ...AgentListInput.fields,
});
export interface AutomationHistoryInput extends Schema.Schema.Type<typeof AutomationHistoryInput> {}

export const AutomationHistoryPage = Schema.Struct({
  occurrences: Schema.Array(AutomationOccurrence),
  runs: Schema.Array(AutomationRun),
  total: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
});
export interface AutomationHistoryPage extends Schema.Schema.Type<typeof AutomationHistoryPage> {}

export const AutomationListPage = Schema.Struct({
  items: Schema.Array(AutomationSummary),
  total: Schema.Int,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
});
export interface AutomationListPage extends Schema.Schema.Type<typeof AutomationListPage> {}

/** Focused authority observation: no transcripts or memory originals in this catalog. */
const AutomationCatalogSnapshot = Schema.Struct({
  revision: Schema.Int,
  automations: Schema.Array(AutomationSummary),
  unresolvedSessions: Schema.Array(AutomationSessionSummary),
  // Hub totals derive from these complete summaries; no separately persisted counters.
});
export interface AutomationCatalogSnapshot extends Schema.Schema.Type<
  typeof AutomationCatalogSnapshot
> {}
export const AutomationCatalogUpdate = Schema.TaggedUnion({
  Snapshot: { snapshot: AutomationCatalogSnapshot },
  Event: {
    revision: Schema.Int,
    event: Schema.TaggedUnion({
      Upserted: { summary: AutomationSummary },
      SessionUpserted: { summary: AutomationSessionSummary },
      SessionRemoved: { sessionId: Schema.String },
    }),
  },
});
export type AutomationCatalogUpdate = typeof AutomationCatalogUpdate.Type;

export const AutomationInspection = Schema.Struct({
  automation: Automation,
  activity: AutomationActivity,
});
export interface AutomationInspection extends Schema.Schema.Type<typeof AutomationInspection> {}
