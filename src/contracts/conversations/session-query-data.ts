import { Schema } from "effect";

const entryId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** Read-only, bounded queries against Pi's authoritative transcript tree. */
export const SessionHistoryQuery = Schema.Struct({
  branch: Schema.optionalKey(Schema.Literals(["active", "all"])),
  leafId: Schema.optionalKey(entryId),
  query: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000))),
  types: Schema.optionalKey(
    Schema.Array(
      Schema.Literals([
        "message",
        "compaction",
        "tool-compaction",
        "branch_summary",
        "model_change",
        "thinking_level_change",
        "custom",
        "custom_message",
        "session_info",
        "label",
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  ),
  roles: Schema.optionalKey(
    Schema.Array(
      Schema.Literals([
        "user",
        "assistant",
        "toolResult",
        "bashExecution",
        "custom",
        "branchSummary",
        "compactionSummary",
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(7)),
  ),
  toolName: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  after: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
    ),
  ),
  before: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
    ),
  ),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
  maxChars: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20_000)),
  ),
});
export interface SessionHistoryQuery extends Schema.Schema.Type<typeof SessionHistoryQuery> {}

export const SessionHistoryEntry = Schema.Struct({
  entryId,
  parentId: Schema.NullOr(entryId),
  timestamp: Schema.String,
  type: Schema.String,
  active: Schema.Boolean,
  role: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        callId: Schema.optionalKey(Schema.String),
        arguments: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  stopReason: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
  isError: Schema.optionalKey(Schema.Boolean),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  tokensBefore: Schema.optionalKey(Schema.Number),
  firstKeptEntryId: Schema.optionalKey(Schema.NullOr(entryId)),
  customType: Schema.optionalKey(Schema.String),
  targetEntryId: Schema.optionalKey(entryId),
  sourceLeafId: Schema.optionalKey(entryId),
  replayedMessages: Schema.optionalKey(Schema.Number),
  truncated: Schema.optionalKey(Schema.Boolean),
});
export interface SessionHistoryEntry extends Schema.Schema.Type<typeof SessionHistoryEntry> {}

export const SessionInspectionQuery = Schema.Struct({
  kind: Schema.Literals([
    "history",
    "compactions",
    "tree",
    "context",
    "usage",
    "commands",
    "pending",
    "messages-list",
    "messages-read",
  ]),
  entryId: Schema.optionalKey(entryId),
  ...SessionHistoryQuery.fields,
});
export interface SessionInspectionQuery extends Schema.Schema.Type<typeof SessionInspectionQuery> {}

export const QueuedSessionCommand = Schema.Struct({
  command: Schema.String.check(
    Schema.isPattern(/^\/[a-zA-Z][a-zA-Z0-9:_-]*(?:[ \t][^\r\n]*)?$/),
    Schema.isMaxLength(262_144),
  ),
});
export interface QueuedSessionCommand extends Schema.Schema.Type<typeof QueuedSessionCommand> {}

export const QueuedSessionCommandReceipt = Schema.Struct({
  itemId: Schema.String.check(Schema.isUUID(4)),
  status: Schema.Literals(["queued"]),
});
export interface QueuedSessionCommandReceipt extends Schema.Schema.Type<
  typeof QueuedSessionCommandReceipt
> {}
