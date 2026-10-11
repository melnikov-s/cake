import { applySnapshot, batch } from "r-state-tree";
import type { WorktreeOperationCatalogUpdate } from "../../contracts/worktrees/worktree-operation-data";
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
      // Error instances are not Model snapshot values. Project only their validated data.
      const snapshot = {
        ...operation,
        cleanupFailures: operation.cleanupFailures?.map((failure) => ({
          _tag: failure._tag,
          operation: failure.operation,
          resolvedSessionIds: failure.resolvedSessionIds,
          cleanupFailures: failure.cleanupFailures,
          message: failure.message,
        })),
      };
      if (existing) applySnapshot(existing, snapshot);
      else model.operations.push(WorktreeOperation.create(snapshot));
    }
  });
}
