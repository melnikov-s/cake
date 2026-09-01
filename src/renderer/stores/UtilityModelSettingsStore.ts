import { Store } from "r-state-tree";
import type { ApplicationState, ThinkingLevel, UtilityModel } from "../../ipc/session-contract";
import { RendererClientContext } from "../client/RendererClientContext";
import { describeError } from "../error-details";

/** Owns optimistic, queued persistence of the configured utility model. */
export class UtilityModelSettingsStore extends Store {
  get workspaces() {
    return RendererClientContext.consume(this)!.workspaces;
  }

  model: UtilityModel | undefined;
  saving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private saveRevision = 0;
  private saveQueue: Promise<unknown> = Promise.resolve();
  private persistedModel: UtilityModel | undefined;

  applyApplicationState(state: ApplicationState) {
    if (this.saving) return;
    this.persistedModel = state.utilityModel;
    this.model = state.utilityModel;
  }

  select(value: string, thinkingLevel?: ThinkingLevel) {
    const separator = value.indexOf("/");
    if (separator < 1) return Promise.resolve();
    return this.save({
      provider: value.slice(0, separator),
      modelId: value.slice(separator + 1),
      thinkingLevel: thinkingLevel ?? this.model?.thinkingLevel ?? "off",
    });
  }

  selectThinkingLevel(thinkingLevel: ThinkingLevel) {
    if (!this.model) return Promise.resolve();
    return this.save({ ...this.model, thinkingLevel });
  }

  clear() {
    return this.save(undefined);
  }

  private save(model: UtilityModel | undefined) {
    const revision = ++this.saveRevision;
    this.model = model;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.saveQueue
      .catch(() => undefined)
      .then(() => this.workspaces.setUtilityModel(model, { signal: this.signal }))
      .then((state) => {
        if (this.signal.aborted) return;
        this.persistedModel = state.utilityModel;
        if (revision === this.saveRevision) this.model = state.utilityModel;
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.saveRevision) return;
        this.model = this.persistedModel;
        this.reportError(error);
      })
      .finally(() => {
        if (!this.signal.aborted && revision === this.saveRevision) this.saving = false;
      });
    this.saveQueue = save;
    return save;
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
}
