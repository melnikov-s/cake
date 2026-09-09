import { Schema } from "effect";
import { worktreeRecordSchema } from "../ipc/worktree-contract";

const ManagedWorktreeEvent = Schema.TaggedUnion({
  Upserted: { worktree: worktreeRecordSchema },
});
/** Current-first, ordered projection of main-owned Managed Worktree lifecycle records. */
export const ManagedWorktreeCatalogUpdate = Schema.TaggedUnion({
  Snapshot: { worktrees: Schema.Array(worktreeRecordSchema) },
  Event: { event: ManagedWorktreeEvent },
});
export type ManagedWorktreeCatalogUpdate = Schema.Schema.Type<typeof ManagedWorktreeCatalogUpdate>;
