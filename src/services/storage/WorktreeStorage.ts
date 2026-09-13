import { Context, Schema, type Effect } from "effect";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";

export class WorktreeStorageError extends Schema.TaggedError<WorktreeStorageError>()(
  "WorktreeStorageError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface WorktreeStorageService {
  readonly load: () => Effect.Effect<ReadonlyArray<WorktreeRecord>, WorktreeStorageError>;
  readonly save: (
    records: ReadonlyArray<WorktreeRecord>,
  ) => Effect.Effect<void, WorktreeStorageError>;
}

/** Cake-owned persistence boundary for Managed Worktree metadata. */
export class WorktreeStorage extends Context.Service<WorktreeStorage, WorktreeStorageService>()(
  "cake/services/storage/WorktreeStorage",
) {}
