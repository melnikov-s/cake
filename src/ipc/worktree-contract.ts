import { Schema } from "effect";
import { ipcProjectionArray } from "./projection";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const worktreeRecordSchema = Schema.Struct({
  projectPath: bounded(1, 4_096),
  worktreePath: bounded(1, 4_096),
  branch: bounded(1, 512),
  baseBranch: bounded(1, 512),
  parentWorktreePath: Schema.optional(bounded(1, 4_096)),
  baseCommit: Schema.optional(bounded(1, 256)),
  state: Schema.optional(Schema.Literals(["active", "landed", "resolved", "discarded", "missing"])),
  pendingStrategy: Schema.optionalKey(Schema.Literals(["preserve", "squash"])),
  createdAt: Schema.String,
});
export type WorktreeRecord = typeof worktreeRecordSchema.Type;
export const worktreeStatusSchema = Schema.Struct({
  record: worktreeRecordSchema,
  targetBranch: bounded(1, 512),
  dirtyCount: nonNegativeInt,
  aheadCount: nonNegativeInt,
  merged: Schema.Boolean,
  targetDirty: Schema.Boolean,
  targetOnBranch: Schema.Boolean,
  merging: Schema.Boolean,
  rebasing: Schema.Boolean,
  squashMessageReady: Schema.Boolean,
});
export type WorktreeStatus = typeof worktreeStatusSchema.Type;
export const worktreeLandRequestSchema = Schema.Union([
  Schema.Struct({
    strategy: Schema.Literal("preserve"),
    allowDirtyTarget: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    strategy: Schema.Literal("squash"),
    message: Schema.optional(bounded(1, 6_000)),
    allowDirtyTarget: Schema.optional(Schema.Literal(true)),
  }),
]);
export type WorktreeLandRequest = typeof worktreeLandRequestSchema.Type;
export interface WorktreeLandingCoordinator {
  proposeSquashMessage(input: {
    workspacePath: string;
    subject: string;
    body?: string;
  }): Promise<void>;
}
export const worktreeLandOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("landed"),
    commit: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  }),
  Schema.Struct({
    outcome: Schema.Literal("resolving"),
    files: ipcProjectionArray(Schema.String.check(Schema.isMaxLength(4_096)), 10_000),
  }),
  Schema.Struct({ outcome: Schema.Literal("proposal") }),
]);
export type WorktreeLandOutcome = typeof worktreeLandOutcomeSchema.Type;
