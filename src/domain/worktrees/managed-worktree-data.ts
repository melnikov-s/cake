import { Schema } from "effect";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));

/** Main-owned persisted Managed Worktree metadata. */
export const WorktreeRecord = Schema.Struct({
  projectPath: bounded(1, 4_096),
  worktreePath: bounded(1, 4_096),
  branch: bounded(1, 512),
  baseBranch: bounded(1, 512),
  parentWorktreePath: Schema.optional(bounded(1, 4_096)),
  baseCommit: Schema.optional(bounded(1, 256)),
  state: Schema.optional(Schema.Literals(["active", "landed", "resolved", "discarded", "missing"])),
  pendingStrategy: Schema.optionalKey(Schema.Literals(["preserve", "squash"])),
  resolveAfterLanding: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.String,
});
export interface WorktreeRecord extends Schema.Schema.Type<typeof WorktreeRecord> {}

/** Managed Worktree facts included in Project Session domain projections. */
export const ManagedWorktreeContext = Schema.Struct({
  projectPath: Schema.String,
  worktreePath: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  parentWorktreePath: Schema.optionalKey(Schema.String),
  baseCommit: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(
    Schema.Literals(["active", "landed", "resolved", "discarded", "missing"]),
  ),
  pendingStrategy: Schema.optionalKey(Schema.Literals(["preserve", "squash"])),
  createdAt: Schema.String,
});
export interface ManagedWorktreeContext extends Schema.Schema.Type<typeof ManagedWorktreeContext> {}

const ManagedWorktreeEvent = Schema.TaggedUnion({
  Upserted: { worktree: WorktreeRecord },
});
/** Current-first, ordered projection of main-owned Managed Worktree lifecycle records. */
export const ManagedWorktreeCatalogUpdate = Schema.TaggedUnion({
  Snapshot: { worktrees: Schema.Array(WorktreeRecord) },
  Event: { event: ManagedWorktreeEvent },
});
export type ManagedWorktreeCatalogUpdate = Schema.Schema.Type<typeof ManagedWorktreeCatalogUpdate>;
