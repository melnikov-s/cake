import type { AutoMergeRequest } from "../../contracts/worktrees/auto-merge";
import { Model, child, observable } from "r-state-tree";
import { WorktreeOperation } from "./WorktreeOperation";

/** Window projection of process-lifetime Managed Worktree operation progress. */
export class WorktreeOperationCatalog extends Model {
  autoMergeEnabled = false;
  autoMergeStatus: string | undefined;
  autoMergeRequests: AutoMergeRequest[] = observable([]);

  @child(WorktreeOperation) operations: WorktreeOperation[] = observable([]);

  find(workspacePath: string) {
    return this.operations.find((operation) => operation.workspacePath === workspacePath);
  }
}
