import { Schema } from "effect";
import { WorktreeLandingOperation } from "./worktree-landing-data";

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

/** Agent-facing receipt: Git success and lifecycle completion are independent facts. */
export const WorktreeMergeAndResolveReport = Schema.Struct({
  command: Schema.Literal("worktrees.merge-and-resolve"),
  outcome: Schema.Literals([
    "landed-and-resolved",
    "resolution-failed",
    "landed",
    "awaiting-agent",
    "stalled",
    "failed",
    "in-progress",
    "canceled",
  ]),
  landed: Schema.Boolean,
  resolved: Schema.Boolean,
  operationId: bounded(256),
  sessionId: bounded(256),
  workingDirectory: bounded(4096),
  phase: Schema.optionalKey(WorktreeLandingOperation.fields.phase),
  targetBranch: Schema.optionalKey(bounded(512)),
  landedCommit: WorktreeLandingOperation.fields.landedCommit,
  conflictFiles: WorktreeLandingOperation.fields.conflictFiles,
  pauseReason: WorktreeLandingOperation.fields.pauseReason,
  error: WorktreeLandingOperation.fields.error,
  resolutionError: WorktreeLandingOperation.fields.resolutionError,
  resolvedSessionIds: WorktreeLandingOperation.fields.resolvedSessionIds,
  cleanupFailures: WorktreeLandingOperation.fields.cleanupFailures,
  worktreeState: Schema.optionalKey(Schema.String),
  nextStep: Schema.String,
});
export interface WorktreeMergeAndResolveReport extends Schema.Schema.Type<
  typeof WorktreeMergeAndResolveReport
> {}
