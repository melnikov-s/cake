import { Model, id } from "r-state-tree";
import type { WorktreeRecord } from "../../domain/managed-worktree-data";

/** Passive renderer projection of one main-owned Managed Worktree record. */
export class ManagedWorktree extends Model {
  projectPath = "";
  @id worktreePath = "";
  branch = "";
  baseBranch = "";
  baseCommit: string | undefined;
  parentWorktreePath: string | undefined;
  state: WorktreeRecord["state"];
  createdAt = "";
  pendingStrategy: WorktreeRecord["pendingStrategy"];
  resolveAfterLanding: WorktreeRecord["resolveAfterLanding"];
}
