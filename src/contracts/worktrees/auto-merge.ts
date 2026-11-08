import { Schema } from "effect";

/** Proportionate task validation with no known clear regression caused by the change.
 * Unrelated failures and infrastructure timeouts are diagnostics, not global green gates.
 * These explicit assertions are never inferred from completion prose. */
export const MergeReadiness = Schema.Struct({
  readyToMerge: Schema.Boolean,
  taskCompleted: Schema.Boolean,
  validationPassed: Schema.Boolean,
  validatedCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
});
export interface MergeReadiness extends Schema.Schema.Type<typeof MergeReadiness> {}

/** Eligibility accepts current-run metadata; it does not authorize automatic landing. */
export const MergeReadinessResult = Schema.Union([
  Schema.Struct({ eligible: Schema.Literal(true) }),
  Schema.Struct({ eligible: Schema.Literal(false), reason: Schema.NonEmptyString }),
]);
export type MergeReadinessResult = typeof MergeReadinessResult.Type;

export const AutoMergeOutcome = Schema.Struct({
  targetBranch: Schema.String,
  landedCommit: Schema.optionalKey(Schema.String),
  merged: Schema.Boolean,
  resolutionSucceeded: Schema.Boolean,
  message: Schema.String,
});
export interface AutoMergeOutcome extends Schema.Schema.Type<typeof AutoMergeOutcome> {}

export const AutoMergeRequest = Schema.Struct({
  readyToMerge: Schema.Boolean,
  id: Schema.String,
  sessionId: Schema.String,
  workspacePath: Schema.String,
  coordinatorSessionId: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(AutoMergeOutcome),
  epoch: Schema.String,
  runId: Schema.String,
  attempt: Schema.optionalKey(Schema.Int),
  commit: Schema.String,
  state: Schema.Literals(["pending", "ready", "landing", "landed", "failed", "canceled"]),
  message: Schema.optionalKey(Schema.String),
});
export interface AutoMergeRequest extends Schema.Schema.Type<typeof AutoMergeRequest> {}
