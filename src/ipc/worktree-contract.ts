import { z } from "zod";
import { ipcProjectionArray } from "./projection";

/**
 * A Cake-managed Git worktree created for isolated session work.
 *
 * Worktrees live outside the repository in a sibling directory, use an
 * `agent/`-namespaced branch, and are cleaned up by Cake after their work is
 * merged back or discarded.
 */
export const worktreeRecordSchema = z.object({
  /** The registered project (repository) the worktree was created from. */
  projectPath: z.string().min(1).max(4_096),
  /** Absolute path of the worktree checkout; doubles as the session workspace path. */
  worktreePath: z.string().min(1).max(4_096),
  branch: z.string().min(1).max(512),
  /** The branch this worktree was branched from and lands back into. */
  baseBranch: z.string().min(1).max(512),
  /** The managed parent checkout for a stacked worktree. Omitted when targeting the project checkout. */
  parentWorktreePath: z.string().min(1).max(4_096).optional(),
  /** Exact commit used to create this checkout. */
  baseCommit: z.string().min(1).max(256).optional(),
  state: z.enum(["active", "landed", "discarded", "missing"]).optional(),
  createdAt: z.string().datetime(),
});

export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;

export const worktreeStatusSchema = z.object({
  record: worktreeRecordSchema,
  targetBranch: z.string().min(1).max(512),
  /** Uncommitted or untracked files in the worktree. */
  dirtyCount: z.number().int().nonnegative(),
  /** Commits on the worktree branch that are not reachable from the base branch. */
  aheadCount: z.number().int().nonnegative(),
  /** True when the branch tip is already contained in the base branch. */
  merged: z.boolean(),
  /** True when the checkout receiving this worktree has uncommitted changes. */
  targetDirty: z.boolean(),
  /** False when the receiving checkout has another branch checked out. */
  targetOnBranch: z.boolean(),
  /** True while a conflicted merge is in progress inside the worktree awaiting resolution. */
  merging: z.boolean(),
});

export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;

export const workspaceGitStatusSchema = z.object({
  workspacePath: z.string().min(1).max(4_096),
  dirtyCount: z.number().int().nonnegative(),
});

export type WorkspaceGitStatus = z.infer<typeof workspaceGitStatusSchema>;

export const workspaceCommitSchema = z.object({
  commit: z.string().min(1).max(256),
});

export type WorkspaceCommit = z.infer<typeof workspaceCommitSchema>;

export const worktreeLandOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("landed"),
    /** The squash-merge commit on the base branch, when commits were merged. */
    commit: z.string().max(256).optional(),
  }),
  z.object({
    outcome: z.literal("conflicts"),
    files: ipcProjectionArray(z.string().max(4_096), 10_000),
  }),
  z.object({
    /** A conflicted merge was started in the worktree for the session agent to resolve. */
    outcome: z.literal("resolving"),
    files: ipcProjectionArray(z.string().max(4_096), 10_000),
  }),
]);

export type WorktreeLandOutcome = z.infer<typeof worktreeLandOutcomeSchema>;
