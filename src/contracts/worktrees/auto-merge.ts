import { Schema } from "effect";

/** Proportionate task validation with no known clear regression caused by the change.
 * Unrelated failures and infrastructure timeouts are diagnostics, not global green gates.
 * These explicit assertions are never inferred from completion prose. Cake binds readiness
 * to the worktree's current HEAD; `validatedCommit` (full or prefix) only asserts it. */
export const MergeReadiness = Schema.Struct({
  readyToMerge: Schema.Boolean,
  taskCompleted: Schema.Boolean,
  validationPassed: Schema.Boolean,
  validatedCommit: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{7,64}$/))),
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

/** Presentation only: never grants landing or resolution authority. */
export function autoMergeOutcomeLabel(outcome: AutoMergeOutcome): string {
  if (!outcome.merged) return "Merge blocked";
  return outcome.resolutionSucceeded ? "Merged and resolved" : "Merged · resolution failed";
}

export const ProjectAutoMerge = Schema.Struct({
  projectPath: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  epoch: Schema.String,
  status: Schema.String,
});
export interface ProjectAutoMerge extends Schema.Schema.Type<typeof ProjectAutoMerge> {}

export const AutoMergeRequest = Schema.Struct({
  /** Absent on legacy declarations: never authorize without a fresh owning-project declaration. */
  projectPath: Schema.optionalKey(Schema.NonEmptyString),
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
  /** Consecutive agent repair turns; absent on an original task declaration. */
  repairAttempt: Schema.optionalKey(Schema.Int),
  /** Exact predecessor declaration; counts alone do not prove repair lineage. */
  repairOfRequestId: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["pending", "ready", "landing", "landed", "failed", "canceled"]),
  message: Schema.optionalKey(Schema.String),
});
export interface AutoMergeRequest extends Schema.Schema.Type<typeof AutoMergeRequest> {}
