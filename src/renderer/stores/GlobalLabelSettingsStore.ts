import { Store, observable } from "r-state-tree";
import type {
  ApplicationState,
  SessionLabelColor,
  SessionLabel,
  SessionLabelMutation,
} from "../../domain/application/application-data";
import { validateSessionLabelName } from "../../domain/application/application-data";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

/** Owns global session-label configuration and its pending command state. */
export class GlobalLabelSettingsStore extends Store {
  readonly labels: SessionLabel[] = observable([]);
  addingLabel = false;
  private readonly pendingLabelIds = observable(new Set<string>());
  private applicationRevision = -1;
  error: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.applicationRevision) return;
    this.applicationRevision = revision;
    this.labels.splice(0, this.labels.length, ...state.globalSessionLabels);
  }

  labelPending(labelId: string) {
    return this.pendingLabelIds.has(labelId);
  }

  async addLabel(name: string, color: SessionLabelColor) {
    const validation = validateSessionLabelName(name);
    if (!validation.ok || this.addingLabel) {
      if (!validation.ok) this.error = validation.message;
      return false;
    }
    this.addingLabel = true;
    try {
      return await this.mutateLabel({
        _tag: "AddLabel",
        label: { id: crypto.randomUUID(), name: validation.name, color },
      });
    } finally {
      this.addingLabel = false;
    }
  }

  async updateLabel(labelId: string, input: { name?: string; color?: SessionLabelColor }) {
    const validation = input.name === undefined ? undefined : validateSessionLabelName(input.name);
    if (validation && !validation.ok) {
      this.error = validation.message;
      return false;
    }
    return this.mutatePendingLabel(labelId, {
      _tag: "UpdateLabel",
      labelId: labelId,
      ...(validation ? { name: validation.name } : undefined),
      ...(input.color ? { color: input.color } : undefined),
    });
  }

  moveLabel(labelId: string, index: number) {
    return this.mutatePendingLabel(labelId, { _tag: "MoveLabel", labelId, index });
  }

  deleteLabel(labelId: string) {
    return this.mutatePendingLabel(labelId, { _tag: "DeleteLabel", labelId });
  }

  private async mutatePendingLabel(labelId: string, mutation: SessionLabelMutation) {
    if (this.pendingLabelIds.has(labelId)) return false;
    this.pendingLabelIds.add(labelId);
    try {
      return await this.mutateLabel(mutation);
    } finally {
      this.pendingLabelIds.delete(labelId);
    }
  }

  private async mutateLabel(mutation: SessionLabelMutation) {
    if (this.signal.aborted) return false;
    this.error = undefined;
    try {
      await this.client.projectWorkflow.mutateGlobal({ mutation }, { signal: this.signal });
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
      return false;
    }
  }
}
