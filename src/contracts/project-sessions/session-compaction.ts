import { Schema } from "effect";

const reference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const instructions = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000)));
export const SessionCompactInput = Schema.Struct({ sessionId: reference, instructions });
export const SessionCompactBatchInput = Schema.Struct({
  sessionIds: Schema.Array(reference).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  instructions,
});

/** Regular-Pi runtime evidence, never an intake/queue receipt. */
export const IdleCompactionResult = Schema.Struct({
  status: Schema.Literals(["compacted", "unchanged", "busy"]),
});
export interface IdleCompactionResult extends Schema.Schema.Type<typeof IdleCompactionResult> {}

export const SessionCompactionResult = Schema.Struct({
  reference,
  sessionId: Schema.optionalKey(Schema.String),
  status: Schema.Literals([
    "compacted",
    "unchanged",
    "busy",
    "invalid",
    "unauthorized",
    "unavailable",
    "failed",
  ]),
  message: Schema.optionalKey(Schema.String),
  duplicateOf: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export interface SessionCompactionResult extends Schema.Schema.Type<
  typeof SessionCompactionResult
> {}
export const SessionCompactionOutput = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.Literals(["sessions.compact", "sessions.compact-batch"]),
  results: Schema.Array(SessionCompactionResult),
});

const sessionCompactionGuidance = [
  "Only compact on a user request. Supply Project Session identities or discovered suffixes, not titles. context.compact still compacts only the invoking conversation.",
  "Project Chat and Project Session callers are limited to their own project; global Cake Chat may target authorized projects. Resolved history can be compacted if its checkout remains available. Drafts and retired/missing worktrees are unavailable; this never restores or resolves anything.",
  "Busy targets are skipped, never aborted or queued. Retry explicitly after work settles. compacted means Pi finished and persisted compaction; unchanged means Pi reports already compacted or nothing to compact. Provider/extension errors are failures, not success.",
  "Batch results preserve input order, continue after individual failures, and deduplicate canonical identities (including suffix aliases). duplicateOf is the zero-based first result index and repeats its outcome. Once started, compaction retains its runtime until Pi settles, even if the caller disconnects. No automatic retries or durable request-id replay; unchanged history is a Pi no-op, while new history can be compacted by a later request.",
  "For user-requested to-do cleanup, todos.list/read exposes state and associations. Select the requested items (done is not session resolution), collect kind: session sessionIds and session identities in cake://session links, then call sessions.compact-batch. Report missing links and per-session outcomes; never close to-dos or compact merely because they are done.",
];
export const sessionCompactionDefinitions = [
  {
    command: "sessions.compact",
    topic: "sessions",
    summary:
      "Compact one authorized idle Project Session through its Pi runtime and return completion evidence.",
    guidance: sessionCompactionGuidance,
    inputSchema: SessionCompactInput,
    examples: [{ input: { sessionId: "target-session-id" } }],
    result: "Ordered per-target outcomes; ok only when every outcome is compacted or unchanged.",
  },
  {
    command: "sessions.compact-batch",
    topic: "sessions",
    summary:
      "Compact up to 100 targeted Project Sessions, deduplicating identities and reporting partial failures.",
    guidance: sessionCompactionGuidance,
    inputSchema: SessionCompactBatchInput,
    examples: [{ input: { sessionIds: ["first-session-id", "second-session-id"] } }],
    result:
      "Ordered per-target outcomes with canonical sessionId and duplicateOf where available; ok only when all succeed.",
  },
] as const;
