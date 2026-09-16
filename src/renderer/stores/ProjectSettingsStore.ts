import { Store, observable } from "r-state-tree";
import {
  defaultProjectSettings,
  PROJECT_ICON_DATA_MAX_LENGTH,
  type ProjectIcon,
  type ProjectSettings,
  type SessionLabelColor,
  type SessionLabelMutation,
  validateSessionLabelName,
} from "../../domain/application/application-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";

/** Owns the project-settings dialog draft and its serialized save workflow. */
export class ProjectSettingsStore extends Store<{
  projects: ProjectCatalogStore;
}> {
  projectPath: string | undefined;
  worktreeCreateCommand = "";
  worktreeSetupCommands = "";
  worktreeSetupInstructions = "";
  icon: ProjectIcon | undefined;
  saving = false;
  choosingIcon = false;
  addingLabel = false;
  private readonly pendingLabelIds = observable(new Set<string>());
  error: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  get projectName() {
    return this.projectPath ? this.props.projects.nameForPath(this.projectPath) : "Project";
  }

  get canSave() {
    return Boolean(
      this.projectPath && this.worktreeCreateCommand.trim() && !this.saving && !this.choosingIcon,
    );
  }

  get labels() {
    return this.projectPath
      ? (this.props.projects.find(this.projectPath)?.workflow.labels ?? [])
      : [];
  }

  labelPending(labelId: string) {
    return this.pendingLabelIds.has(labelId);
  }

  open(projectPath: string) {
    if (this.saving) return;
    const settings = this.props.projects.find(projectPath)?.settings ?? defaultProjectSettings();
    this.projectPath = projectPath;
    this.worktreeCreateCommand = settings.worktreeCreateCommand;
    this.worktreeSetupCommands = settings.worktreeSetupCommands;
    this.worktreeSetupInstructions = settings.worktreeSetupInstructions;
    this.icon = settings.icon;
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

  setWorktreeSetupInstructions(instructions: string) {
    this.worktreeSetupInstructions = instructions;
  }

  async chooseIcon() {
    if (this.choosingIcon) return;
    this.choosingIcon = true;
    this.error = undefined;
    try {
      const selected = await this.client.filesystem.chooseAttachments({ signal: this.signal });
      if (this.signal.aborted || selected.length === 0) return;
      const image = selected.find(
        (item): item is Extract<(typeof selected)[number], { kind: "image" }> =>
          item.kind === "image",
      );
      if (
        !image ||
        (image.mimeType !== "image/png" &&
          image.mimeType !== "image/jpeg" &&
          image.mimeType !== "image/gif" &&
          image.mimeType !== "image/webp")
      ) {
        this.error = "Choose a PNG, JPEG, GIF, or WebP image";
        return;
      }
      if (image.data.length > PROJECT_ICON_DATA_MAX_LENGTH) {
        this.error = "Project icons must be smaller than 750 KB";
        return;
      }
      this.icon = { mimeType: image.mimeType, data: image.data };
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.choosingIcon = false;
    }
  }

  removeIcon() {
    this.icon = undefined;
    this.error = undefined;
  }

  resetDefaults() {
    const settings = defaultProjectSettings();
    this.worktreeCreateCommand = settings.worktreeCreateCommand;
    this.worktreeSetupCommands = settings.worktreeSetupCommands;
    this.worktreeSetupInstructions = settings.worktreeSetupInstructions;
    this.error = undefined;
  }

  async addLabel(name: string, color: SessionLabelColor) {
    const validation = validateSessionLabelName(name);
    if (!validation.ok || !this.projectPath || this.addingLabel) {
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
      worktreeSetupInstructions: this.worktreeSetupInstructions.trim(),
      ...(this.icon ? { icon: this.icon } : undefined),
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
