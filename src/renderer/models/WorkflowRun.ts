import { Model, child, id, observable } from "r-state-tree";
import type { WorkflowRun as RunData } from "../../contracts/workflows/workflow-data";
import { WorkflowStep } from "./WorkflowStep";

/** Optional detail projection, separate from compact catalog records. */
export class WorkflowRun extends Model {
  @id id = "";
  loaded = false;
  observationRevision = -1;
  ownerSessionId = "";
  projectPath = "";
  workingDirectory = "";
  program: RunData["program"] | undefined;
  status: RunData["status"] = "running";
  revision = 0;
  execution = 1;
  usage: RunData["usage"];
  maxConcurrentAgents = 1;
  createdAt = "";
  updatedAt = "";
  phases: string[] = observable([]);
  logs: string[] = observable([]);
  @child(WorkflowStep) steps: WorkflowStep[] = observable([]);
  result: RunData["result"];
  error: string | undefined;
}
