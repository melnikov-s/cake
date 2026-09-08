import { Schema } from "effect";
import { worktreeStatusSchema } from "../ipc/worktree-contract";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));

export const WorktreeLandingPhase = Schema.Literals([
  "waiting",
  "landing",
  "committing",
  "rebasing",
  "resolving",
  "resolving-rebase",
  "proposing",
  "stalled",
  "landed",
  "complete",
  "failed",
]);
export type WorktreeLandingPhase = typeof WorktreeLandingPhase.Type;

export const WorktreeLandingOperation = Schema.Struct({
  operationId: bounded(1, 256),
  workspacePath: bounded(1, 4_096),
  sessionId: bounded(1, 256),
  kind: Schema.Literals(["landing", "rebase"]),
  phase: WorktreeLandingPhase,
  strategy: Schema.optionalKey(Schema.Literals(["preserve", "squash"])),
  allowDirtyTarget: Schema.Boolean,
  pauseReason: Schema.optionalKey(
    Schema.Literals(["commit", "conflict", "rebase-conflict", "squash-message"]),
  ),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
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
