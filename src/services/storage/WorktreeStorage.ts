import { Context, Schema, type Effect } from "effect";
import type { WorktreeRecord } from "../../ipc/worktree-contract";

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

export class WorktreeStorage extends Context.Service<WorktreeStorage, WorktreeStorageService>()(
  "cake/services/storage/WorktreeStorage",
) {}

/** Promise adapter used only by the existing Managed Worktree engine. */
export interface WorktreeStorageRepository {
  readonly load: () => Promise<ReadonlyArray<WorktreeRecord>>;
  readonly save: (records: ReadonlyArray<WorktreeRecord>) => Promise<void>;
}
