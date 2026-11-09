import { Store } from "r-state-tree";
import type { ApplicationState } from "../../contracts/application/application-data";
import {
  changeLeftToolbarPreferences,
  defaultLeftToolbarPreferences,
  normalizeLeftToolbarPreferences,
  type LeftToolbarChange,
} from "../../utils/left-toolbar-preferences";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Main-owned preferences, projected live in every window. No hover state is saved. */
export class LeftToolbarSettingsStore extends Store {
  preferences = defaultLeftToolbarPreferences();
  saving = false;
  error: string | undefined;
  private revision = -1;
  private editRevision = 0;
  private persisted = defaultLeftToolbarPreferences();
  private saves: Promise<void> = Promise.resolve();

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.revision) return;
    this.revision = revision;
    this.persisted = normalizeLeftToolbarPreferences(state.leftToolbar);
    if (!this.saving) this.preferences = this.persisted;
  }

  change(change: LeftToolbarChange) {
    const edit = ++this.editRevision;
    this.preferences = changeLeftToolbarPreferences(this.preferences, change);
    this.saving = true;
    this.error = undefined;
    const save = this.saves.then(async () => {
      if (this.signal.aborted) return;
      const observedRevision = this.revision;
      try {
        const state = await ClientContext.consume(this)!.workspaces.setLeftToolbarPreferences(
          change,
          { signal: this.signal },
        );
        if (this.signal.aborted) return;
        // An ordered live projection received during the request is newer evidence
        // than its unversioned response (another window may already have edited).
        if (observedRevision === this.revision)
          this.persisted = normalizeLeftToolbarPreferences(state.leftToolbar);
        if (edit === this.editRevision) this.preferences = this.persisted;
      } catch (error) {
        if (this.signal.aborted || edit !== this.editRevision) return;
        this.preferences = this.persisted;
        this.error = describeError(error).message;
      } finally {
        if (!this.signal.aborted && edit === this.editRevision) this.saving = false;
      }
    });
    this.saves = save;
    return save;
  }
}
