import { Store } from "r-state-tree";
import { DEFAULT_EDITOR_COMMAND, type ApplicationState } from "../../ipc/session-contract";
import type { DesktopClient } from "../desktop-client";
import { describeError } from "../error-details";

export interface EditorSettingsStoreProps {
  client: Pick<DesktopClient, "setEditorCommand">;
}

/** Owns optimistic, ordered persistence of the external editor command. */
export class EditorSettingsStore extends Store<EditorSettingsStoreProps> {
  command = DEFAULT_EDITOR_COMMAND;
  saving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private saveRevision = 0;
  private saveQueue: Promise<unknown> = Promise.resolve();
  private persistedCommand = DEFAULT_EDITOR_COMMAND;

  applyApplicationState(state: ApplicationState) {
    if (this.saving) return;
    this.persistedCommand = state.editorCommand?.trim() || DEFAULT_EDITOR_COMMAND;
    this.command = this.persistedCommand;
  }

  setCommand(command: string) {
    const revision = ++this.saveRevision;
    const normalized = command.trim() || DEFAULT_EDITOR_COMMAND;
    this.command = normalized;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.saveQueue
      .catch(() => undefined)
      .then(() => this.props.client.setEditorCommand(normalized))
      .then((state) => {
        if (this.signal.aborted) return;
        this.persistedCommand = state.editorCommand?.trim() || DEFAULT_EDITOR_COMMAND;
        if (revision === this.saveRevision) this.command = this.persistedCommand;
      })
      .catch((error) => {
        if (this.signal.aborted || revision !== this.saveRevision) return;
        this.command = this.persistedCommand;
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
