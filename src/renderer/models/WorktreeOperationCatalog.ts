import { Model, child, observable } from "r-state-tree";
import { WorktreeOperation } from "./WorktreeOperation";

/** Window projection of process-lifetime Managed Worktree operation progress. */
export class WorktreeOperationCatalog extends Model {
  @child(WorktreeOperation) operations: WorktreeOperation[] = observable([]);

  find(workspacePath: string) {
    return this.operations.find((operation) => operation.workspacePath === workspacePath);
  }
}
