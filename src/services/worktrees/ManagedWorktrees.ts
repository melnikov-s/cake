import {
  Context,
  type Duration,
  type Effect,
  type FileSystem,
  type Path,
  type Stream,
} from "effect";
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

/** Why a checkout is being removed; configured remove commands receive it as `{removeReason}`. */
export type WorktreeRemoveReason = "discard" | "resolve" | "rollback";

/**
 * A project's configured lifecycle commands, selected by Cake policy. The engine renders and
 * runs them; an absent create or remove command uses the built-in `git worktree` operation.
 */
export interface WorktreeLifecycle {
  /** Checks out the existing `{branchName}` in a new worktree, wherever the tool chooses. */
  readonly createCommand?: string;
  readonly setupCommand?: string;
  readonly removeCommand?: string;
  /** Per-command limit; absent waits indefinitely. */
  readonly timeout?: Duration.Input;
}

/** Fully selected Cake creation request. The engine reserves its branch, materializes the
 * checkout and learns the checkout's real location from Git. */
export interface WorktreeCheckoutPlan {
  readonly projectPath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly parentWorktreePath?: string;
  /** The registered project's directory relative to its repository root; empty at the root. */
  readonly projectSubpath: string;
  /** Suggested checkout root for the built-in command and `{checkoutPath}`. */
  readonly checkoutPath: string;
  readonly lifecycle: WorktreeLifecycle;
}

export interface ManagedWorktreesService {
  readonly records: () => Effect.Effect<ReadonlyArray<WorktreeRecord>, ManagedWorktreeError>;
  readonly observe: () => Stream.Stream<ManagedWorktreeCatalogUpdate, ManagedWorktreeError>;
  /** Runs the domain planner with this engine's Git/filesystem/path capabilities under its
   * repository lock and reserves the planned branch there. Checkout and setup commands run
   * outside the lock. Background setup, when requested, remains owned by this Service's Scope. */
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
    lifecycle: WorktreeLifecycle,
  ) => Effect.Effect<void, ManagedWorktreeError>;
  /**
   * Retires a resolved Working Directory. Landed checkouts must contain no unlanded work.
   * With `retireActive`, an unlanded checkout without uncommitted work is removed too and its
   * branch is kept when it has commits. Returns whether the checkout was retired.
   */
  readonly cleanupResolved: (
    worktreePath: string,
    options: { readonly lifecycle: WorktreeLifecycle; readonly retireActive: boolean },
  ) => Effect.Effect<boolean, ManagedWorktreeError>;
  readonly restoreResolved: (
    worktreePath: string,
    lifecycle: WorktreeLifecycle,
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
