import { Store } from "r-state-tree";
import type { CakePrompts } from "../../domain/application/cake-prompts";
import type { ApplicationState } from "../../ipc/session-contract";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

/** Owns editing and persistence for Cake-generated workflow prompts. */
export class CakePromptSettingsStore extends Store {
  get workspaces() {
    return ClientContext.consume(this)!.workspaces;
  }

  prompts: CakePrompts | undefined;
  saving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private saveRevision = 0;
  private saveQueue: Promise<unknown> = Promise.resolve();
  private persistedPrompts: CakePrompts | undefined;
  private applicationRevision = -1;

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.applicationRevision) return;
    this.applicationRevision = revision;
    this.persistedPrompts = state.cakePrompts;
    if (!this.saving) this.prompts = state.cakePrompts;
  }

  update<Key extends keyof CakePrompts>(key: Key, value: CakePrompts[Key]) {
    if (!this.prompts) return Promise.resolve();
    return this.save({ ...this.prompts, [key]: value });
  }

  private save(prompts: CakePrompts) {
    const revision = ++this.saveRevision;
    this.prompts = prompts;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        const baseRevision = this.applicationRevision;
        await this.workspaces.setCakePrompts(prompts, { signal: this.signal });
        return baseRevision;
      })
      .then((baseRevision) => {
        if (this.signal.aborted) return;
        if (revision === this.saveRevision && this.applicationRevision > baseRevision)
          this.prompts = this.persistedPrompts;
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.saveRevision) return;
        this.prompts = this.persistedPrompts;
        const described = describeError(error);
        this.error = described.message;
        this.errorDetails = described.details;
      })
      .finally(() => {
        if (!this.signal.aborted && revision === this.saveRevision) this.saving = false;
      });
    this.saveQueue = save;
    return save;
  }
}
