import { applySnapshot, batch } from "r-state-tree";
import type { WorktreeOperationCatalogUpdate } from "../../domain/worktrees/worktree-operation-data";
import { WorktreeOperation } from "../models/WorktreeOperation";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";

export function applyWorktreeOperationCatalogUpdate(
  model: WorktreeOperationCatalog,
  update: WorktreeOperationCatalogUpdate,
) {
  const incomingPaths = new Set(update.operations.map((operation) => operation.workspacePath));
  batch(() => {
    for (let index = model.operations.length - 1; index >= 0; index -= 1)
      if (!incomingPaths.has(model.operations[index]!.workspacePath))
        model.operations.splice(index, 1);
    for (const operation of update.operations) {
      const existing = model.find(operation.workspacePath);
      if (existing) applySnapshot(existing, operation);
      else model.operations.push(WorktreeOperation.create(operation));
    }
  });
}
