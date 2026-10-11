import { Model, child, id, observable } from "r-state-tree";
import type { WorkflowRunSummary } from "../../contracts/workflows/workflow-data";
import { WorkflowRun } from "./WorkflowRun";

/** Project-owned compact cards. Source, answers and worker parts are loaded separately. */
export class WorkflowCatalog extends Model {
  @id sessionId = "";
  revision = -1;
  runs: (Omit<WorkflowRunSummary, "id"> & { id: string })[] = observable([]);
  @child(WorkflowRun) details: WorkflowRun[] = observable([]);

  detail(runId: string) {
    let detail = this.details.find((run) => run.id === runId);
    if (!detail) {
      detail = WorkflowRun.create({ id: runId, ownerSessionId: this.sessionId });
      this.details.push(detail);
    }
    return detail;
  }
}
