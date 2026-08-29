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
  /** Strategy of a landing that is paused inside this worktree awaiting the session agent. */
  pendingStrategy: z.enum(["preserve", "squash"]).optional(),
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
  /** True while a rebase is in progress inside the worktree awaiting resolution. */
  rebasing: z.boolean(),
  /** True when the session agent proposed a squash message for the current branch tip. */
  squashMessageReady: z.boolean(),
});

export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;

/**
 * How the worktree branch reaches its target.
 *
 * - `preserve` replays the worktree commits onto the target branch one by one
 *   and needs no model involvement.
 * - `squash` combines the worktree into one target commit. Without an explicit
 *   `message`, the session agent proposes the commit message first.
 */
export const worktreeLandRequestSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("preserve") }),
  z.object({
    strategy: z.literal("squash"),
    message: z.string().min(1).max(6_000).optional(),
  }),
]);

export type WorktreeLandRequest = z.infer<typeof worktreeLandRequestSchema>;

/** Resolves the pending squash-message request for the calling worktree workspace. */
export interface WorktreeLandingCoordinator {
  proposeSquashMessage(input: {
    workspacePath: string;
    subject: string;
    body?: string;
  }): Promise<void>;
}

export const worktreeLandOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("landed"),
    /** The commit created on the target branch, when commits were merged. */
    commit: z.string().max(256).optional(),
  }),
  z.object({
    /** A conflicted rebase or merge was started in the worktree for the session agent to resolve. */
    outcome: z.literal("resolving"),
    files: ipcProjectionArray(z.string().max(4_096), 10_000),
  }),
  z.object({
    /** The session agent must propose a squash commit message before landing continues. */
    outcome: z.literal("proposal"),
  }),
]);

export type WorktreeLandOutcome = z.infer<typeof worktreeLandOutcomeSchema>;
