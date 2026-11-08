import type { AutoMergeRequest, ProjectAutoMerge } from "../../contracts/worktrees/auto-merge";
import { Model, child, observable } from "r-state-tree";
import { WorktreeOperation } from "./WorktreeOperation";

/** Window projection of process-lifetime Managed Worktree operation progress. */
export class WorktreeOperationCatalog extends Model {
  autoMergeProjects: ProjectAutoMerge[] = observable([]);
  autoMergeRequests: AutoMergeRequest[] = observable([]);

  @child(WorktreeOperation) operations: WorktreeOperation[] = observable([]);

  find(workspacePath: string) {
    return this.operations.find((operation) => operation.workspacePath === workspacePath);
  }
}
