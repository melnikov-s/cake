import { Store, snapshot } from "r-state-tree";
import {
  defaultSpeechInputPreferences,
  normalizeSpeechInputPreferences,
  type SpeechInputNumericSetting,
} from "../../utils/speech-input-settings";

/** Window-owned shared speech-input and voice-only policy preferences.
 * Persisted through the Store snapshot; last local edit wins. Each workflow
 * freezes the applicable values on capture entry, never mutating a live run. */
export class SpeechInputSettingsStore extends Store {
  @snapshot preferences = { ...defaultSpeechInputPreferences };
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
  reset(): void {
    this.preferences = { ...defaultSpeechInputPreferences };
  }
}
