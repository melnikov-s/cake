import { Store } from "r-state-tree";
import type { ApplicationState } from "../../contracts/conversations/session-contract";
import type {
  NonChatModelPreferences,
  NonChatModelReference,
  NonChatModelType,
} from "../../contracts/models/non-chat-model-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Backend-owned advisory references; this window owns only the optimistic edit workflow. */
export class NonChatModelSettingsStore extends Store {
  preferences: NonChatModelPreferences = {};
  saving = false;
  error: string | undefined;
  errorSection: "images" | "classifiers" = "images";
  private persisted: NonChatModelPreferences = {};
  private applicationRevision = -1;
  private saveRevision = 0;
  private saveQueue: Promise<unknown> = Promise.resolve();

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.applicationRevision) return;
    this.applicationRevision = revision;
    this.persisted = state.nonChatModelPreferences ?? {};
    if (!this.saving) this.preferences = this.persisted;
  }

  select(type: NonChatModelType, preference: NonChatModelReference | null) {
    if (this.signal.aborted) return Promise.resolve();
    const revision = ++this.saveRevision;
    const optimistic = { ...this.preferences };
    if (preference === null) delete optimistic[type];
    else optimistic[type] = preference;
    this.preferences = optimistic;
    this.saving = true;
    this.error = undefined;
    const save = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.signal.aborted) return;
        const baseRevision = this.applicationRevision;
        const response = await ClientContext.consume(this)!.nonChatModels.updatePreference(
          { type, preference },
          { signal: this.signal },
        );
        if (this.signal.aborted) return;
        // Observation may already have delivered a newer cross-window update.
        if (this.applicationRevision <= baseRevision) this.persisted = response;
        if (revision === this.saveRevision) this.preferences = this.persisted;
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.saveRevision) return;
        this.preferences = this.persisted;
        this.errorSection = type === "image" ? "images" : "classifiers";
        this.error = describeError(error).message;
      })
      .finally(() => {
        if (!this.signal.aborted && revision === this.saveRevision) this.saving = false;
      });
    this.saveQueue = save;
    return save;
  }
}
