import { Store } from "r-state-tree";
import { DEFAULT_DICTATION_CLEANUP_MINIMUM_CHARACTERS } from "../../contracts/application/application-data";
import type { ApplicationState } from "../../contracts/application/application-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Application-owned cleanup policy shared by every speech input surface. */
export class SpeechCleanupSettingsStore extends Store {
  minimumCharacters = DEFAULT_DICTATION_CLEANUP_MINIMUM_CHARACTERS;
  saving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private applicationRevision = -1;
  private saveRevision = 0;
  private persistedMinimum = DEFAULT_DICTATION_CLEANUP_MINIMUM_CHARACTERS;
  private saveQueue: Promise<unknown> = Promise.resolve();

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.applicationRevision) return;
    this.applicationRevision = revision;
    this.persistedMinimum = state.dictationCleanupMinimumCharacters;
    if (!this.saving) this.minimumCharacters = this.persistedMinimum;
  }

  setMinimumCharacters(minimum: number) {
    if (!Number.isSafeInteger(minimum) || minimum < 0) return Promise.resolve();
    const revision = ++this.saveRevision;
    this.minimumCharacters = minimum;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        const baseRevision = this.applicationRevision;
        await ClientContext.consume(this)!.workspaces.setDictationCleanupMinimumCharacters(
          minimum,
          {
            signal: this.signal,
          },
        );
        return baseRevision;
      })
      .then((baseRevision) => {
        if (this.signal.aborted) return;
        if (revision === this.saveRevision && this.applicationRevision > baseRevision)
          this.minimumCharacters = this.persistedMinimum;
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.saveRevision) return;
        this.minimumCharacters = this.persistedMinimum;
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
