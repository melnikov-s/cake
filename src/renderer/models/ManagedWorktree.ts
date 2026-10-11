import { Model, id } from "r-state-tree";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";

/** Passive renderer projection of one main-owned Managed Worktree record. */
export class ManagedWorktree extends Model {
  projectPath = "";
  @id worktreePath = "";
  branch = "";
  baseBranch = "";
  baseCommit: string | undefined;
  parentWorktreePath: string | undefined;
  state: WorktreeRecord["state"];
  resolvedFrom: WorktreeRecord["resolvedFrom"];
  createdAt = "";
  pendingStrategy: WorktreeRecord["pendingStrategy"];
  resolveAfterLanding: WorktreeRecord["resolveAfterLanding"];
}
