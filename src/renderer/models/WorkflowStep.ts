import { Model, id } from "r-state-tree";
import type {
  WorkflowStep as StepData,
  WorkflowWorkerActivity,
} from "../../contracts/workflows/workflow-data";

/** Passive main-owned step projection; worker transcript payload is demand-only. */
export class WorkflowStep extends Model {
  @id id = "";
  ordinal = 0;
  execution = 1;
  phase: string | undefined;
  input: StepData["input"] = { prompt: "", options: {} };
  workingDirectory = "";
  status: StepData["status"] = "queued";
  attempt = 1;
  resolvedModel: StepData["resolvedModel"] = {
    provider: "",
    modelId: "",
    thinkingLevel: "off",
    fastMode: false,
  };
  result: StepData["result"];
  error: string | undefined;
  usage: StepData["usage"];
  activity: (Omit<WorkflowWorkerActivity, "stepId"> & { stepId: string }) | undefined;
}
