import { Store } from "r-state-tree";
import { defaultProjectSettings, type ProjectSettings } from "../../domain/application-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../error-details";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";

/** Owns the project-settings dialog draft and its serialized save workflow. */
export class ProjectSettingsStore extends Store<{ projects: ProjectCatalogStore }> {
  projectPath: string | undefined;
  worktreeCreateCommand = "";
  worktreeSetupCommands = "";
  saving = false;
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
