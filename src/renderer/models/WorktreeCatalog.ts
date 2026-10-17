import { Model, child, findModelById, observable } from "r-state-tree";
import { ManagedWorktree } from "./ManagedWorktree";

/** Window-lifetime catalog of authoritative Managed Worktree projections. */
export class WorktreeCatalog extends Model {
  @child(ManagedWorktree) worktrees: ManagedWorktree[] = observable([]);

  find(worktreePath: string) {
    // Track the first insertion before the tree has a ManagedWorktree ID bucket.
    if (this.worktrees.length === 0) return undefined;
    const worktree = findModelById(this, ManagedWorktree, worktreePath);
    return worktree?.parent === this ? worktree : undefined;
  }

  forProject(projectPath: string) {
    return this.worktrees.filter((worktree) => worktree.projectPath === projectPath);
  }
}
