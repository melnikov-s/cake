import { Store, child, createStore } from "r-state-tree";
import {
  defaultProjectSettings,
  type ProjectSettings,
} from "../../contracts/application/application-data";
import { ProjectIdentityStore } from "./ProjectIdentityStore";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

export class ProjectSetupStore extends Store<{ onAdded(path: string): Promise<void> | void }> {
  path: string | undefined;
  worktreeLanding: ProjectSettings["worktreeLanding"] = "merge";
  saving = false;
  error: string | undefined;
  private revision = 0;
  @child get identity(): ProjectIdentityStore {
    return createStore(ProjectIdentityStore);
  }
  get canSave() {
    return Boolean(this.path && this.identity.valid && !this.identity.busy && !this.saving);
  }
  open(path: string, name: string) {
    this.revision += 1;
    this.path = path;
    this.identity.reset(name);
    this.worktreeLanding = "merge";
    this.error = undefined;
  }
  close(force = false) {
    if (this.saving && !force) return;
    this.revision += 1;
    if (force) this.saving = false;
    this.identity.cancel();
    this.path = undefined;
  }
  setWorktreeLanding(value: ProjectSettings["worktreeLanding"]) {
    this.worktreeLanding = value;
  }
  async save() {
    if (!this.canSave || !this.path) return false;
    const path = this.path;
    const revision = this.revision;
    this.saving = true;
    this.error = undefined;
    try {
      await ClientContext.consume(this)!.workspaces.registerProject(
        path,
        this.identity.name.trim(),
        { signal: this.signal },
        {
          ...defaultProjectSettings(),
          worktreeLanding: this.worktreeLanding,
          ...(this.identity.icon ? { icon: this.identity.icon } : undefined),
        },
      );
      if (this.signal.aborted || revision !== this.revision) return false;
      this.path = undefined;
      this.identity.cancel();
      await this.props.onAdded(path);
      return true;
    } catch (error) {
      if (!this.signal.aborted && revision === this.revision)
        this.error = describeError(error).message;
      return false;
    } finally {
      if (revision === this.revision) this.saving = false;
    }
  }
}
