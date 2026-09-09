import { Model, child, observable } from "r-state-tree";
import { ManagedWorktree } from "./ManagedWorktree";

/** Window-lifetime catalog of authoritative Managed Worktree projections. */
export class WorktreeCatalog extends Model {
  @child(ManagedWorktree) worktrees: ManagedWorktree[] = observable([]);

  find(worktreePath: string) {
    return this.worktrees.find((worktree) => worktree.worktreePath === worktreePath);
  }

  forProject(projectPath: string) {
    return this.worktrees.filter((worktree) => worktree.projectPath === projectPath);
  }
}
