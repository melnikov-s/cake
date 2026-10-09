import type { PocketTtsState } from "../../src/domain/speech/pocket-tts-data";
import type { SpeechOutputSettings } from "../../src/domain/speech/speech-output-data";

export const pocketTtsState = (overrides: Partial<PocketTtsState> = {}): PocketTtsState => ({
  supported: true,
  engineAvailable: true,
  selected: false,
  speed: 1,
  installed: false,
  installing: false,
  downloadedBytes: 0,
  totalBytes: 369_779_063,
  ...overrides,
});

export const speechOutputSettings = (
  overrides: Partial<SpeechOutputSettings> = {},
): SpeechOutputSettings => ({
  provider: "elevenlabs",
  keyConfigured: false,
  modelId: "eleven_flash_v2_5",
  speed: 1,
  voices: [],
  localModel: pocketTtsState({ selected: overrides.provider === "pocket-tts" }),
  ...overrides,
});
