import { Store, snapshot } from "r-state-tree";
import type { DictationDiscardFilter } from "../../contracts/dictation/discard-filters";
import {
  validDiscardFilter,
  normalizeSpeechInputPreferences,
  type SpeechInputNumericSetting,
} from "../../utils/speech-input-settings";

/** Window-owned shared speech-input and voice-only policy preferences.
 * Persisted through the Store snapshot; last local edit wins. Recognition tuning freezes
 * on capture entry; DictationStore seals and restarts capture for voice-submission edits. */
export class SpeechInputSettingsStore extends Store {
  @snapshot preferences = normalizeSpeechInputPreferences();
  get values() {
    return normalizeSpeechInputPreferences(this.preferences);
  }
  setNumber(key: SpeechInputNumericSetting, value: number): void {
    this.preferences = normalizeSpeechInputPreferences({ ...this.values, [key]: value });
  }
  setShortCommands(enabled: boolean): void {
    this.preferences = { ...this.values, shortCommands: enabled };
  }
  setDictationVoiceSend(enabled: boolean): void {
    this.preferences = { ...this.values, dictationVoiceSend: enabled };
  }
  setDictationSendPhrase(phrase: string): void {
    this.preferences = { ...this.values, dictationSendPhrase: phrase };
  }
  addDiscardFilter(filter: DictationDiscardFilter): void {
    if (!validDiscardFilter(filter))
      throw new Error("Enter a discard phrase of 1–256 characters containing words.");
    this.preferences = normalizeSpeechInputPreferences({
      ...this.values,
      dictationDiscardFilters: [...this.values.dictationDiscardFilters, filter],
    });
  }
  editDiscardFilter(index: number, filter: DictationDiscardFilter): void {
    if (!validDiscardFilter(filter))
      throw new Error("Enter a discard phrase of 1–256 characters containing words.");
    const filters = [...this.values.dictationDiscardFilters];
    if (!filters[index])
      throw new Error("Discard filter no longer exists. Read settings.dictation.get.");
    filters[index] = filter;
    this.preferences = normalizeSpeechInputPreferences({
      ...this.values,
      dictationDiscardFilters: filters,
    });
  }
  removeDiscardFilter(index: number): void {
    this.preferences = {
      ...this.values,
      dictationDiscardFilters: this.values.dictationDiscardFilters.filter((_, i) => i !== index),
    };
  }
  reset(): void {
    this.preferences = normalizeSpeechInputPreferences();
  }
}
