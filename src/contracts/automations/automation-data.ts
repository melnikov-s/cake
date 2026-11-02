import { Schema } from "effect";
import { AgentListInput } from "../agent/agent-list-data";
import { SessionChatConfiguration } from "../conversations/conversation-data";
import { attachmentSchema } from "../conversations/session-contract";
import { OptMemoryId } from "../memory/opt-memory-data";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const AUTOMATION_MEMORY_VIEW_BYTES = 10_000;

export const AutomationId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("AutomationId"),
);
export type AutomationId = typeof AutomationId.Type;
export const AutomationRunId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("AutomationRunId"),
);
export type AutomationRunId = typeof AutomationRunId.Type;
export const AutomationOccurrenceId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("AutomationOccurrenceId"),
);
export type AutomationOccurrenceId = typeof AutomationOccurrenceId.Type;

/** Context supplies normal Pi resource loading, not Project Session or family identity. */
export const AutomationContext = Schema.TaggedUnion({
  Global: {}, // Resolve the backend user's home directory at execution time.
  Project: { projectPath: boundedPath }, // Explicit registered project; no implicit worktree.
});
export type AutomationContext = typeof AutomationContext.Type;

/** Lifecycle is independent of session activity and resolution. */
export const AutomationState = Schema.TaggedUnion({
  active: {},
  paused: {},
  suspended: { reason },
  archived: {},
});
export type AutomationState = typeof AutomationState.Type;

export const AutomationSchedule = Schema.TaggedUnion({
  Once: { at: timestamp },
  Interval: {
    startsAt: timestamp,
    everySeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60)),
  },
  Calendar: {
    // Domain validation parses cron and the IANA zone. UI presents repeat controls, not cron.
    expression: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    timeZone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    startsAt: timestamp,
  },
});
export type AutomationSchedule = typeof AutomationSchedule.Type;

/** These are source-session kinds, not execution destinations. Automation runs are not sources. */
const AutomationEventSessionKind = Schema.Literals([
  "cake-chat",
  "project-chat",
  "standalone-project-session",
  "family-root",
  "family-child",
]);
export type AutomationEventSessionKind = typeof AutomationEventSessionKind.Type;
export const AutomationEventKind = Schema.Literals([
  "user-message-received",
  "assistant-response-completed",
  "session-created",
]);
export type AutomationEventKind = typeof AutomationEventKind.Type;

/** Transient authoritative input. Only successful final replies and genuine user messages qualify. */
export const AutomationSourceEvent = Schema.Struct({
  eventId: boundedId,
  event: AutomationEventKind,
  occurredAt: timestamp,
  sourceSessionId: boundedId,
  sourceKind: AutomationEventSessionKind,
  projectPath: Schema.optionalKey(boundedPath),
  sourceMessageId: Schema.optionalKey(boundedId),
  text: Schema.optionalKey(Schema.String),
});
export interface AutomationSourceEvent extends Schema.Schema.Type<typeof AutomationSourceEvent> {}

export const AutomationEventFilter = Schema.Struct({
  event: AutomationEventKind,
  scope: Schema.TaggedUnion({ Any: {}, Global: {}, Project: { projectPath: boundedPath } }),
  sessionKinds: Schema.Array(AutomationEventSessionKind).check(
    Schema.isMinLength(1),
    Schema.isUnique(),
  ),
  sessionId: Schema.optionalKey(boundedId),
  contentContains: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  ),
});
export interface AutomationEventFilter extends Schema.Schema.Type<typeof AutomationEventFilter> {}

const AutomationTrigger = Schema.TaggedUnion({
  Schedule: { schedule: AutomationSchedule },
  Event: { filter: AutomationEventFilter },
});
export type AutomationTrigger = typeof AutomationTrigger.Type;

/** Fully explicit saved execution settings; no dependence on the creator's later conversation. */
export const AutomationDefinition = Schema.Struct({
  name: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
  context: AutomationContext,
  trigger: AutomationTrigger,
  task: Schema.Struct({
    prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
    configuration: SessionChatConfiguration,
    attachments: Schema.Array(attachmentSchema).check(Schema.isMaxLength(20)),
  }),
  overlap: Schema.Literals(["skip", "queue", "parallel"]),
  completion: Schema.Literals(["auto-resolve", "keep-for-review"]),
});
export interface AutomationDefinition extends Schema.Schema.Type<typeof AutomationDefinition> {}

/** Cake metadata only; Pi remains the conversation/transcript authority. */
export const Automation = Schema.Struct({
  id: AutomationId,
  definition: AutomationDefinition,
  state: AutomationState,
  memoryId: OptMemoryId,
  createdAt: timestamp,
  updatedAt: timestamp,
  nextScheduledAt: Schema.optionalKey(timestamp),
});
export interface Automation extends Schema.Schema.Type<typeof Automation> {}

/** Durable provenance references, not a second copy of event message bodies. */
export const AutomationOccurrenceSource = Schema.TaggedUnion({
  Manual: { requestedBySessionId: Schema.optionalKey(boundedId) },
  Schedule: { scheduledAt: timestamp },
  Event: {
    eventId: boundedId,
    event: AutomationEventKind,
    sourceSessionId: boundedId,
    sourceMessageId: Schema.optionalKey(boundedId),
  },
});
export type AutomationOccurrenceSource = typeof AutomationOccurrenceSource.Type;

export const AutomationOccurrence = Schema.Struct({
  id: AutomationOccurrenceId,
  automationId: AutomationId,
  source: AutomationOccurrenceSource,
  occurredAt: timestamp,
  // Freeze queued work. Definition edits affect future occurrences, not accepted work.
  definition: AutomationDefinition,
  disposition: Schema.TaggedUnion({
    queued: {},
    started: { runId: AutomationRunId },
    skipped: { reason },
    canceled: { reason },
    blocked: { reason },
  }),
});
export interface AutomationOccurrence extends Schema.Schema.Type<typeof AutomationOccurrence> {}

/** No session exists for queued work. A run links one started occurrence to one Pi session. */
export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  occurrenceId: AutomationOccurrenceId,
  sessionId: boundedId,
  context: AutomationContext,
  workingDirectory: boundedPath,
  sessionDirectory: boundedPath,
  startedAt: timestamp,
  status: Schema.TaggedUnion({
    running: {},
    completed: { finishedAt: timestamp },
    failed: { finishedAt: timestamp, reason },
    canceled: { finishedAt: timestamp, reason },
  }),
  // Resolution comes from SessionArchiveStorage, not a duplicate flag on this record.
});
export interface AutomationRun extends Schema.Schema.Type<typeof AutomationRun> {}

/** New selectable Cake session kind; never fabricate a project for global execution. */
const AutomationSessionIdentity = Schema.TaggedStruct("AutomationSession", {
  sessionId: boundedId,
  automationId: AutomationId,
  runId: AutomationRunId,
  context: AutomationContext,
  workingDirectory: boundedPath,
});
export interface AutomationSessionIdentity extends Schema.Schema.Type<
  typeof AutomationSessionIdentity
> {}

/** Sidebar projection reads Pi/catalog activity and the existing resolution authority. */
export const AutomationSessionSummary = Schema.Struct({
  identity: AutomationSessionIdentity,
  title: Schema.String,
  createdAt: timestamp,
  modifiedAt: timestamp,
  resolved: Schema.Boolean,
  unread: Schema.Boolean,
  running: Schema.Boolean,
});
export interface AutomationSessionSummary extends Schema.Schema.Type<
  typeof AutomationSessionSummary
> {}

/** Derived projection. Running and queued can coexist, including while paused. */
export const AutomationActivity = Schema.Struct({
  runningSessions: count,
  queuedOccurrences: count,
});
export interface AutomationActivity extends Schema.Schema.Type<typeof AutomationActivity> {}

export const AutomationSummary = Schema.Struct({
  id: AutomationId,
  name: AutomationDefinition.fields.name,
  context: AutomationContext,
  state: AutomationState,
  activity: AutomationActivity,
  nextScheduledAt: Schema.optionalKey(timestamp),
});
export interface AutomationSummary extends Schema.Schema.Type<typeof AutomationSummary> {}

export const AutomationListInput = Schema.Struct({
  ...AgentListInput.fields,
  context: Schema.optionalKey(AutomationContext),
  state: Schema.optionalKey(Schema.Literals(["active", "paused", "suspended", "archived"])),
  runningOnly: Schema.optionalKey(Schema.Boolean),
});
export interface AutomationListInput extends Schema.Schema.Type<typeof AutomationListInput> {}

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  operation: Schema.String,
  code: Schema.Literals(["not-found", "invalid-configuration", "invalid-state", "unavailable"]),
  message: reason,
}) {}
