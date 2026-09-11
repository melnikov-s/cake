import { Context, Schema, type Effect, type Stream } from "effect";
import type {
  ManagedWorktreeCatalogUpdate,
  WorktreeRecord,
} from "../../domain/worktrees/managed-worktree-data";
import type { ProjectSettings } from "../../domain/application/application-data";
import type {
  WorktreeLandOutcome,
  WorktreeLandRequest,
  WorktreeRebaseOutcome,
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
  readonly observe: () => Stream.Stream<ManagedWorktreeCatalogUpdate, ManagedWorktreeError>;
  readonly create: (
    projectPath: string,
    baseWorktreePath?: string,
    worktreeName?: string,
    settings?: ProjectSettings,
  ) => Effect.Effect<WorktreeRecord, ManagedWorktreeError>;
  /** Returns once the checkout exists while setup continues in this Service's Scope. */
  readonly createWithBackgroundSetup: (
    projectPath: string,
    baseWorktreePath?: string,
    worktreeName?: string,
    settings?: ProjectSettings,
  ) => Effect.Effect<WorktreeRecord, ManagedWorktreeError>;
  /** Blocks runtime acquisition and turns until deferred setup has completed. */
  readonly awaitSetup: (worktreePath: string) => Effect.Effect<void, ManagedWorktreeError>;
  readonly hasDeferredSetup: (worktreePath: string) => Effect.Effect<boolean>;
  readonly status: (
    worktreePath: string,
  ) => Effect.Effect<WorktreeStatus | undefined, ManagedWorktreeError>;
  readonly prepareLanding: (
    worktreePath: string,
    operationId: string,
  ) => Effect.Effect<void, ManagedWorktreeError>;
  readonly setResolveAfterLanding: (
    worktreePath: string,
    enabled: boolean,
  ) => Effect.Effect<void, ManagedWorktreeError>;
  readonly land: (
    worktreePath: string,
    operationId: string,
    request: WorktreeLandRequest,
  ) => Effect.Effect<WorktreeLandOutcome, ManagedWorktreeError>;
  readonly cancelLanding: (
    worktreePath: string,
    operationId: string,
    onlyIfQueued?: boolean,
  ) => Effect.Effect<void, ManagedWorktreeError>;
  readonly rebase: (
    worktreePath: string,
  ) => Effect.Effect<WorktreeRebaseOutcome, ManagedWorktreeError>;
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
