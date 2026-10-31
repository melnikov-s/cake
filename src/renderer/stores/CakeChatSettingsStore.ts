import { Store } from "r-state-tree";
import type { ApplicationState } from "../../contracts/conversations/session-contract";
import {
  cakeChatModelSettingDefaults,
  defaultCakeChatPreferences,
  defaultAssistantPreferences,
  type CakeChatModelSetting,
} from "../../contracts/cake-chats/cake-chat-preferences";
import type { CakeChatPreferences } from "../../contracts/application/application-data";
import type { CakeModelChoice } from "../../contracts/model-presets/cake-model-selection";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Application preferences are main-owned. This window owns optimistic edits and serialized saves. */
export class CakeChatSettingsStore extends Store<{ companion?: boolean }> {
  preferences = this.defaults();
  saving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private revision = -1;
  private editRevision = 0;
  private persisted = this.defaults();

  private defaults() {
    return this.props.companion ? defaultAssistantPreferences() : defaultCakeChatPreferences();
  }
  private fromState(state: ApplicationState) {
    return (
      (this.props.companion ? state.assistantPreferences : state.cakeChatPreferences) ??
      this.defaults()
    );
  }
  private saves: Promise<unknown> = Promise.resolve();

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision <= this.revision) return;
    this.revision = revision;
    this.persisted = this.fromState(state);
    if (!this.saving) this.preferences = this.persisted;
  }

  setContextLimit(tokens: number) {
    return this.save({ ...this.preferences, contextLimitTokens: tokens });
  }

  setBudget(bytes: number) {
    return this.save({ ...this.preferences, memoryViewBytes: bytes });
  }
  setInstructions(instructions: string) {
    return this.save({ ...this.preferences, instructions });
  }
  /** Choosing a setting's default source stores nothing, matching the out-of-the-box value. */
  setModelChoice(setting: CakeChatModelSetting, choice: CakeModelChoice) {
    const preferences = { ...this.preferences };
    delete preferences[setting];
    return this.save(
      choice.source === cakeChatModelSettingDefaults[setting].source
        ? preferences
        : { ...preferences, [setting]: choice },
    );
  }

  private save(preferences: CakeChatPreferences) {
    const edit = ++this.editRevision;
    this.preferences = preferences;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    const save = this.saves
      .catch(() => undefined)
      .then(async () => {
        const state = await ClientContext.consume(this)!.workspaces.setCakeChatPreferences(
          preferences,
          { signal: this.signal },
          ...(this.props.companion ? ([true] as const) : []),
        );
        if (this.signal.aborted) return;
        this.persisted = this.fromState(state);
        if (edit === this.editRevision) this.preferences = this.persisted;
      })
      .catch((error) => {
        if (this.signal.aborted || edit !== this.editRevision) return;
        this.preferences = this.persisted;
        const described = describeError(error);
        this.error = described.message;
        this.errorDetails = described.details;
      })
      .finally(() => {
        if (!this.signal.aborted && edit === this.editRevision) this.saving = false;
      });
    this.saves = save;
    return save;
  }
}
