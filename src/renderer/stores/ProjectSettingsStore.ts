import { Store, observable } from "r-state-tree";
import {
  defaultProjectSettings,
  type ProjectSettings,
  type ProjectWorkflowColor,
  type ProjectWorkflowMutation,
  validateProjectWorkflowColumnName,
} from "../../domain/application/application-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";

/** Owns the project-settings dialog draft and its serialized save workflow. */
export class ProjectSettingsStore extends Store<{ projects: ProjectCatalogStore }> {
  projectPath: string | undefined;
  worktreeCreateCommand = "";
  worktreeSetupCommands = "";
  saving = false;
  addingStatus = false;
  private readonly pendingStatusIds = observable(new Set<string>());
  error: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  get projectName() {
    return this.projectPath ? this.props.projects.nameForPath(this.projectPath) : "Project";
  }

  get canSave() {
    return Boolean(this.projectPath && this.worktreeCreateCommand.trim() && !this.saving);
  }

  get statuses() {
    return this.projectPath
      ? (this.props.projects.find(this.projectPath)?.workflow.columns ?? [])
      : [];
  }

  statusPending(statusId: string) {
    return this.pendingStatusIds.has(statusId);
  }

  open(projectPath: string) {
    if (this.saving) return;
    const settings = this.props.projects.find(projectPath)?.settings ?? defaultProjectSettings();
    this.projectPath = projectPath;
    this.worktreeCreateCommand = settings.worktreeCreateCommand;
    this.worktreeSetupCommands = settings.worktreeSetupCommands;
    this.error = undefined;
  }

  close() {
    if (!this.saving) this.projectPath = undefined;
  }

  setWorktreeCreateCommand(command: string) {
    this.worktreeCreateCommand = command;
  }

  setWorktreeSetupCommands(commands: string) {
    this.worktreeSetupCommands = commands;
  }

  resetDefaults() {
    const settings = defaultProjectSettings();
    this.worktreeCreateCommand = settings.worktreeCreateCommand;
    this.worktreeSetupCommands = settings.worktreeSetupCommands;
    this.error = undefined;
  }

  async addStatus(name: string, color: ProjectWorkflowColor) {
    const validation = validateProjectWorkflowColumnName({ columns: this.statuses }, name);
    if (!validation.ok || !this.projectPath || this.addingStatus) {
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

  async updateStatus(statusId: string, input: { name?: string; color?: ProjectWorkflowColor }) {
    const validation =
      input.name === undefined
        ? undefined
        : validateProjectWorkflowColumnName({ columns: this.statuses }, input.name, statusId);
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

  private async mutatePendingStatus(statusId: string, mutation: ProjectWorkflowMutation) {
    if (this.pendingStatusIds.has(statusId)) return false;
    this.pendingStatusIds.add(statusId);
    try {
      return await this.mutateStatus(mutation);
    } finally {
      this.pendingStatusIds.delete(statusId);
    }
  }

  private async mutateStatus(mutation: ProjectWorkflowMutation) {
    if (!this.projectPath || this.signal.aborted) return false;
    this.error = undefined;
    try {
      await this.client.projectWorkflow.mutate(
        { projectPath: this.projectPath, mutation },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
      return false;
    }
  }

  async save() {
    if (!this.canSave || !this.projectPath) return false;
    const path = this.projectPath;
    const settings: ProjectSettings = {
      worktreeCreateCommand: this.worktreeCreateCommand.trim(),
      worktreeSetupCommands: this.worktreeSetupCommands.trim(),
    };
    this.saving = true;
    this.error = undefined;
    try {
      await this.client.workspaces.setProjectSettings(path, settings, { signal: this.signal });
      if (this.signal.aborted) return false;
      this.projectPath = undefined;
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
      return false;
    } finally {
      if (!this.signal.aborted) this.saving = false;
    }
  }
}
