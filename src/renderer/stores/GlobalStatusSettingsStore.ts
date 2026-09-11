import { Store, observable } from "r-state-tree";
import type {
  ApplicationState,
  WorkflowStatusColor,
  WorkflowStatus,
  WorkflowStatusMutation,
} from "../../domain/application/application-data";
import { validateWorkflowStatusName } from "../../domain/application/application-data";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

/** Owns global session-status configuration and its pending command state. */
export class GlobalStatusSettingsStore extends Store {
  readonly statuses: WorkflowStatus[] = observable([]);
  addingStatus = false;
  private readonly pendingStatusIds = observable(new Set<string>());
  private applicationRevision = -1;
  error: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.applicationRevision) return;
    this.applicationRevision = revision;
    this.statuses.splice(0, this.statuses.length, ...state.globalWorkflowStatuses);
  }

  statusPending(statusId: string) {
    return this.pendingStatusIds.has(statusId);
  }

  async addStatus(name: string, color: WorkflowStatusColor) {
    const validation = validateWorkflowStatusName({ columns: this.statuses }, name);
    if (!validation.ok || this.addingStatus) {
      if (!validation.ok) this.error = validation.message;
      return false;
    }
    this.addingStatus = true;
    try {
      return await this.mutateStatus({
        _tag: "AddColumn",
        column: { id: crypto.randomUUID(), name: validation.name, color },
      });
    } finally {
      this.addingStatus = false;
    }
  }

  async updateStatus(statusId: string, input: { name?: string; color?: WorkflowStatusColor }) {
    const validation =
      input.name === undefined
        ? undefined
        : validateWorkflowStatusName({ columns: this.statuses }, input.name, statusId);
    if (validation && !validation.ok) {
      this.error = validation.message;
      return false;
    }
    return this.mutatePendingStatus(statusId, {
      _tag: "UpdateColumn",
      columnId: statusId,
      ...(validation ? { name: validation.name } : undefined),
      ...(input.color ? { color: input.color } : undefined),
    });
  }

  deleteStatus(statusId: string) {
    return this.mutatePendingStatus(statusId, { _tag: "DeleteColumn", columnId: statusId });
  }

  private async mutatePendingStatus(statusId: string, mutation: WorkflowStatusMutation) {
    if (this.pendingStatusIds.has(statusId)) return false;
    this.pendingStatusIds.add(statusId);
    try {
      return await this.mutateStatus(mutation);
    } finally {
      this.pendingStatusIds.delete(statusId);
    }
  }

  private async mutateStatus(mutation: WorkflowStatusMutation) {
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
