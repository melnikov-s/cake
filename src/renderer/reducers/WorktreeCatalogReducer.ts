import { applySnapshot, batch } from "r-state-tree";
import type { ManagedWorktreeCatalogUpdate } from "../../contracts/worktrees/managed-worktree-data";
import { ManagedWorktree } from "../models/ManagedWorktree";
import type { WorktreeCatalog } from "../models/WorktreeCatalog";

export function applyManagedWorktreeCatalogUpdate(
  model: WorktreeCatalog,
  update: ManagedWorktreeCatalogUpdate,
) {
  if (update._tag === "Snapshot") {
    const paths = update.worktrees.map((worktree) => worktree.worktreePath);
    if (new Set(paths).size !== paths.length)
      throw new Error("Managed Worktree path collision in projection snapshot");
    applySnapshot(model, {
      worktrees: update.worktrees.map((worktree) => ({
        ...worktree,
        defaultBranch: worktree.defaultBranch,
      })),
    });
    return;
  }

  batch(() => {
    const worktree = update.event.worktree;
    const existing = model.find(worktree.worktreePath);
    // Absent local metadata must clear a previously detected default.
    if (existing) applySnapshot(existing, { ...worktree, defaultBranch: worktree.defaultBranch });
    else model.worktrees.push(ManagedWorktree.create(worktree));
  });
}
