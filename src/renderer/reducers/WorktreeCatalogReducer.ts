import { applySnapshot, batch } from "r-state-tree";
import type { ManagedWorktreeCatalogUpdate } from "../../domain/worktrees/managed-worktree-data";
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
    applySnapshot(model, { worktrees: [...update.worktrees] });
    return;
  }

  batch(() => {
    const worktree = update.event.worktree;
    const existing = model.find(worktree.worktreePath);
    if (existing) applySnapshot(existing, worktree);
    else model.worktrees.push(ManagedWorktree.create(worktree));
  });
}
