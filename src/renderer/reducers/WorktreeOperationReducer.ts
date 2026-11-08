import { applySnapshot, batch } from "r-state-tree";
import type { WorktreeOperationCatalogUpdate } from "../../contracts/worktrees/worktree-operation-data";
import { WorktreeOperation } from "../models/WorktreeOperation";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";
import type {
  AutoMergeOutcome,
  AutoMergeRequest,
  ProjectAutoMerge,
} from "../../contracts/worktrees/auto-merge";

/** These projection records are flat except for the request outcome. Ignore key order
 * and absent versus undefined optional fields across transport snapshots. */
function sameFields<T extends AutoMergeRequest | ProjectAutoMerge | AutoMergeOutcome>(
  left: T,
  right: T,
) {
  // SAFETY: Both inputs are validated projection records of the same flat contract;
  // their enumerable transport fields are keys of that contract.
  const keys = [...Object.keys(left), ...Object.keys(right)] as (keyof T)[];
  return keys.every((key) => Object.is(left[key], right[key]));
}

export function applyWorktreeOperationCatalogUpdate(
  model: WorktreeOperationCatalog,
  update: WorktreeOperationCatalogUpdate,
) {
  const incomingPaths = new Set(update.operations.map((operation) => operation.workspacePath));
  batch(() => {
    const projects = update.autoMergeProjects ?? [];
    if (
      model.autoMergeProjects.length !== projects.length ||
      !projects.every((project, index) => sameFields(project, model.autoMergeProjects[index]!))
    )
      model.autoMergeProjects.splice(0, model.autoMergeProjects.length, ...projects);
    const requests = update.autoMergeRequests ?? [];
    if (
      model.autoMergeRequests.length !== requests.length ||
      !requests.every((request, index) => {
        const { outcome, ...fields } = request;
        const { outcome: previousOutcome, ...previousFields } = model.autoMergeRequests[index]!;
        return (
          sameFields(fields, previousFields) &&
          (outcome === previousOutcome ||
            Boolean(outcome && previousOutcome && sameFields(outcome, previousOutcome)))
        );
      })
    )
      model.autoMergeRequests.splice(0, model.autoMergeRequests.length, ...requests);
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
