import { Context, type Effect, type FileSystem, type Path, type Stream } from "effect";
import type { Git } from "../git/Git";
import type {
  ManagedWorktreeCatalogUpdate,
  WorktreeRecord,
} from "../../contracts/worktrees/managed-worktree-data";
import type {
  WorktreeLandOutcome,
  WorktreeLandRequest,
  WorktreeRebaseOutcome,
  WorktreeStatus,
} from "../../contracts/worktrees/worktree-contract";
import type { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";

/** Fully selected Cake creation request; the engine only materializes it. */
export interface WorktreeCheckoutPlan {
  readonly record: WorktreeRecord & { readonly baseCommit: string };
  readonly createCommand?: string;
  readonly setupCommand?: string;
}

export interface ManagedWorktreesService {
  readonly records: () => Effect.Effect<ReadonlyArray<WorktreeRecord>, ManagedWorktreeError>;
  readonly observe: () => Stream.Stream<ManagedWorktreeCatalogUpdate, ManagedWorktreeError>;
  /** Runs the domain planner with this engine's Git/filesystem/path capabilities
   * under its repository lock, shared with checkout/persistence rollback.
   * Background setup, when requested, remains owned by this Service's Scope. */
  readonly createCheckout: (
    projectPath: string,
    prepare: (
      repository: string,
      registeredProjectPath: string,
      records: ReadonlyArray<WorktreeRecord>,
    ) => Effect.Effect<
      WorktreeCheckoutPlan,
      ManagedWorktreeError,
      Git | FileSystem.FileSystem | Path.Path
    >,
    backgroundSetup: boolean,
  ) => Effect.Effect<WorktreeRecord, ManagedWorktreeError>;
  /** Blocks runtime acquisition and turns until deferred setup has completed. */
  readonly awaitSetup: (worktreePath: string) => Effect.Effect<void, ManagedWorktreeError>;
  readonly status: (
    worktreePath: string,
  ) => Effect.Effect<WorktreeStatus | undefined, ManagedWorktreeError>;
  readonly prepareLanding: (
    worktreePath: string,
    operationId: string,
    /** Runs after FIFO insertion, before waiting for promotion. */
    onQueued?: Effect.Effect<void>,
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
