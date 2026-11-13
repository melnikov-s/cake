import { Schema } from "effect";
import { worktreeStatusSchema } from "./worktree-contract";
import { LandingQueueWait } from "./landing-queue";
import { ResolutionCleanupFailed } from "../project-sessions/project-session-resolution";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));

export const WorktreeLandingPhase = Schema.Literals([
  "waiting",
  "queued",
  "landing",
  "committing",
  "rebasing",
  "resolving",
  "resolving-rebase",
  "validating",
  "proposing",
  "stalled",
  "landed",
  "complete",
  "failed",
]);
export type WorktreeLandingPhase = typeof WorktreeLandingPhase.Type;

export const WorktreePromptDecision = Schema.Literals(["run", "cancel", "tool-prune"]);
export type WorktreePromptDecision = typeof WorktreePromptDecision.Type;

export const WorktreeLandingOperation = Schema.Struct({
  operationId: bounded(1, 256),
  workspacePath: bounded(1, 4_096),
  sessionId: bounded(1, 256),
  kind: Schema.Literals(["landing", "rebase"]),
  phase: WorktreeLandingPhase,
  /** Only renderer-originated actions may ask for interactive prompt confirmation. */
  confirmAgentPrompts: Schema.optionalKey(Schema.Literal(true)),
  promptConfirmation: Schema.optionalKey(
    Schema.Struct({
      id: bounded(1, 256),
      estimatedTokens: Schema.Number,
      decision: Schema.optionalKey(WorktreePromptDecision),
    }),
  ),
  queue: Schema.optionalKey(
    Schema.Struct({
      blockingOperationId: bounded(1, 256),
      blockingSessionId: Schema.optionalKey(bounded(1, 256)),
      blockingPhase: Schema.optionalKey(WorktreeLandingPhase),
      position: LandingQueueWait.fields.position,
      queuedAt: LandingQueueWait.fields.queuedAt,
    }),
  ),
  strategy: Schema.optionalKey(Schema.Literals(["preserve", "squash"])),
  allowDirtyTarget: Schema.Boolean,
  resolveAfterLanding: Schema.optionalKey(Schema.Boolean),
  /** Auto-merge success is announced by a transient event, never by this replayable snapshot. */
  automatic: Schema.optionalKey(Schema.Literal(true)),
  /** Stable declaration identity, independent of toggle-authorized attempt IDs. */
  autoMergeRequestId: Schema.optionalKey(bounded(1, 256)),
  /** Accepted cancellation; block replay until readiness revocation is reconciled. */
  cancellationRequested: Schema.optionalKey(Schema.Literal(true)),
  pauseReason: Schema.optionalKey(
    Schema.Literals(["commit", "conflict", "rebase-conflict", "squash-message", "clean-rebase"]),
  ),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  /** Git landing succeeded, but lifecycle completion or clearing its intent failed. */
  resolutionError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  /** Conflicting paths reported by the latest paused landing or rebase attempt. */
  conflictFiles: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(Schema.isMaxLength(10_000)),
  ),
  /** Target-branch commit produced by a landing that replayed new worktree commits. */
  landedCommit: Schema.optionalKey(bounded(1, 256)),
  /** Every Project Session committed as resolved by this landing's resolve-after-landing step. */
  resolvedSessionIds: Schema.optionalKey(
    Schema.Array(bounded(1, 256)).check(Schema.isMaxLength(10_000)),
  ),
  /** Resolution committed; these warnings must not turn a landed merge into a failed merge. */
  cleanupFailures: Schema.optionalKey(
    Schema.Array(ResolutionCleanupFailed).check(Schema.isMaxLength(10_000)),
  ),
});
export interface WorktreeLandingOperation extends Schema.Schema.Type<
  typeof WorktreeLandingOperation
> {}

export const WorktreeLandingSnapshot = Schema.Struct({
  status: Schema.optionalKey(worktreeStatusSchema),
  operation: Schema.optionalKey(WorktreeLandingOperation),
});
export interface WorktreeLandingSnapshot extends Schema.Schema.Type<
  typeof WorktreeLandingSnapshot
> {}

export class WorktreeLandingError extends Schema.TaggedError<WorktreeLandingError>()(
  "WorktreeLandingError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
