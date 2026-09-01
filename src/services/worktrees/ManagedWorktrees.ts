import { Context, Schema, type Effect } from "effect";
import type {
  WorktreeLandOutcome,
  WorktreeLandRequest,
  WorktreeRecord,
  WorktreeStatus,
} from "../../ipc/worktree-contract";

export class ManagedWorktreeError extends Schema.TaggedError<ManagedWorktreeError>()(
  "ManagedWorktreeError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface ManagedWorktreesService {
  readonly records: () => Effect.Effect<ReadonlyArray<WorktreeRecord>, ManagedWorktreeError>;
  readonly create: (
    projectPath: string,
    baseWorktreePath?: string,
    worktreeName?: string,
  ) => Effect.Effect<WorktreeRecord, ManagedWorktreeError>;
  readonly status: (
    worktreePath: string,
  ) => Effect.Effect<WorktreeStatus | undefined, ManagedWorktreeError>;
  readonly land: (
    worktreePath: string,
    request: WorktreeLandRequest,
  ) => Effect.Effect<WorktreeLandOutcome, ManagedWorktreeError>;
  readonly discard: (
    worktreePath: string,
    keepBranch: boolean,
  ) => Effect.Effect<void, ManagedWorktreeError>;
  readonly cleanupResolved: (worktreePath: string) => Effect.Effect<void, ManagedWorktreeError>;
  readonly restoreResolved: (
    worktreePath: string,
  ) => Effect.Effect<WorktreeRecord | undefined, ManagedWorktreeError>;
  readonly proposeSquashMessage: (input: {
    readonly workspacePath: string;
    readonly subject: string;
    readonly body?: string;
  }) => Effect.Effect<void, ManagedWorktreeError>;
}

/** Native Managed Worktree engine; Cake policy is exposed by the domain module. */
export class ManagedWorktrees extends Context.Service<ManagedWorktrees, ManagedWorktreesService>()(
  "cake/services/worktrees/ManagedWorktrees",
) {}
