import { Store, child, createStore } from "r-state-tree";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type {
  WorkflowRunId,
  WorkflowStepId,
  SavedWorkflow,
} from "../../contracts/workflows/workflow-data";
import { ClientContext } from "./context/ClientContext";
import { ChatStore } from "./ChatStore";

type RunControl = "pause" | "resume" | "stop" | "relaunch";

/** Window-local details/controls; Models remain passive main-owned facts.
 * One request at a time per surface; acknowledgement never predicts run status.
 * Closing details only removes observation demand, not backend execution.
 */
export class WorkflowRunStore extends Store<{ model: WorkflowCatalog }> {
  selectedRunId: string | undefined;
  selectedStepId: string | undefined;
  pending: string | undefined;
  error: string | undefined;
  saveName = "";
  saveLocation: SavedWorkflow["location"] = "project";
  saved: SavedWorkflow | undefined;

  get model() {
    return this.props.model;
  }
  get sessionId() {
    return this.model.sessionId;
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  get runs() {
    return this.model.runs;
  }
  get detail() {
    return this.model.details.find((run) => run.id === this.selectedRunId);
  }
  get step() {
    return this.detail?.steps.find((step) => step.id === this.selectedStepId);
  }
  get target() {
    // SAFETY: selectedRunId is taken only from schema-validated catalog records.
    return this.selectedRunId
      ? { sessionId: this.sessionId, runId: this.selectedRunId as WorkflowRunId }
      : undefined;
  }
  get workerTarget() {
    const target = this.target;
    const step = this.step;
    // SAFETY: step IDs originate in the schema-validated detail projection.
    return target && step
      ? { ...target, stepId: step.id as WorkflowStepId, execution: step.execution }
      : undefined;
  }

  open(runId: string) {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    this.model.detail(runId);
    this.selectedRunId = runId;
    this.selectedStepId = undefined;
    this.saveName = run.meta.name;
    this.saved = undefined;
    this.error = undefined;
  }
  close() {
    this.selectedRunId = undefined;
    this.selectedStepId = undefined;
  }
  selectStep(stepId: string) {
    this.selectedStepId = stepId;
  }
  setSaveName(value: string) {
    this.saveName = value;
  }
  setSaveLocation(value: SavedWorkflow["location"]) {
    this.saveLocation = value;
  }

  private async request(
    key: string,
    command: () => Promise<void | { readonly runId: WorkflowRunId }>,
  ) {
    if (this.pending) return;
    this.pending = key;
    this.error = undefined;
    try {
      await command();
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.pending = undefined;
    }
  }

  async control(runId: string, command: RunControl) {
    // SAFETY: controls are supplied IDs from the schema-validated compact catalog.
    const target = { sessionId: this.sessionId, runId: runId as WorkflowRunId };
    await this.request(`${command}:${runId}`, () =>
      this.client.workflows[command](target, { signal: this.signal }),
    );
  }
  async controlWorker(command: "stopWorker" | "restartWorker") {
    const target = this.workerTarget;
    if (!target) return;
    await this.request(`${command}:${target.stepId}`, () =>
      this.client.workflows[command](target, { signal: this.signal }),
    );
  }
  async save() {
    const target = this.target;
    if (!target || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(this.saveName)) return;
    const name = this.saveName;
    const location = this.saveLocation;
    await this.request(`save:${target.runId}`, async () => {
      const saved = await this.client.workflows.save(
        { ...target, name, location },
        { signal: this.signal },
      );
      if (!this.signal.aborted && this.selectedRunId === target.runId) this.saved = saved;
    });
  }

  @child
  get workerChat(): ChatStore {
    return createStore(ChatStore, {
      id: () =>
        `workflow-worker:${this.selectedRunId}:${this.selectedStepId}:${this.step?.execution}:${this.step?.attempt}`,
      parts: () => [...(this.step?.activity?.parts ?? [])],
      streaming: () => this.step?.status === "running" && (this.step.activity?.streaming ?? false),
      submitting: () => false,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Worker activity",
      inputLabel: () => "Workflow worker",
      canSubmit: () => false,
      submit: async () => false,
      composerVisible: () => false,
      usage: () => this.step?.activity?.usage ?? this.step?.usage,
    });
  }
}
