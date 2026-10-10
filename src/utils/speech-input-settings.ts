import { Option, Schema } from "effect";
import type { SpeechRecognitionSettings } from "../services/dictation/dictation-data";

// Preference snapshot decoding stays outside ordinary renderer Stores.
const readNumber = Schema.decodeUnknownOption(Schema.Finite);
const readBoolean = Schema.decodeUnknownOption(Schema.Boolean);

export const speechInputControls = [
  {
    key: "speechStartThreshold",
    scope: "Dictation + voice mode",
    group: "Detection",
    label: "Speech detection sensitivity",
    min: 0.1,
    max: 0.95,
    step: 0.05,
    unit: "percent",
    description:
      "Higher thresholds reject more background noise, but can miss soft speech. Lower thresholds are more sensitive.",
  },
  {
    key: "speechContinueThreshold",
    scope: "Dictation + voice mode",
    group: "Detection",
    label: "Speech continuation threshold",
    min: 0.05,
    max: 0.95,
    step: 0.05,
    unit: "percent",
    description:
      "How confident the detector must remain after speech starts. Cannot exceed the starting threshold; a lower value keeps syllable gaps together.",
  },
  {
    key: "minimumSpeechMs",
    scope: "Dictation + voice mode",
    group: "Detection",
    label: "Minimum speech duration",
    min: 100,
    max: 1000,
    step: 50,
    unit: "ms",
    description:
      "Require sustained detected speech before starting recognition. Longer values ignore brief noises but may miss short replies. Audio arrives in 256 ms frames.",
  },
  {
    key: "prerollMs",
    scope: "Dictation + voice mode",
    group: "Detection",
    label: "Audio lookback",
    min: 0,
    max: 1000,
    step: 50,
    unit: "ms",
    description:
      "Retain audio before speech onset so the beginning of a word is not clipped. The minimum-speech window is always retained too.",
  },
  {
    key: "sendPauseSeconds",
    scope: "Voice mode only",
    group: "Automatic send",
    label: "Pause before automatic send",
    min: 1,
    max: 10,
    step: 0.25,
    unit: "seconds",
    description:
      "Send after this much detected quiet, only when the utterance produced text. Longer pauses allow more time to think.",
  },
  {
    key: "countdownDelaySeconds",
    scope: "Voice mode only",
    group: "Automatic send",
    label: "Countdown display delay",
    min: 0,
    max: 5,
    step: 0.25,
    unit: "seconds",
    description:
      "Hide the ring during short pauses. Must be shorter than the automatic-send pause; this does not change the send deadline.",
  },
  {
    key: "maximumUtteranceSeconds",
    scope: "Dictation + voice mode",
    group: "Detection",
    label: "Maximum utterance length",
    min: 5,
    max: 60,
    step: 1,
    unit: "seconds",
    description:
      "Segment continuous speech at this limit. Dictation keeps appending subsequent segments; voice mode finalizes the utterance for manual sending, never automatically submitting merely at the limit.",
  },
  {
    key: "interruptionWords",
    scope: "Voice mode only",
    group: "Interruptions",
    label: "Words required to interrupt",
    min: 2,
    max: 10,
    step: 1,
    unit: "words",
    description:
      "Recognize this many words before stopping an assistant reply. Higher values are less likely to treat acknowledgments as interruptions.",
  },
  {
    key: "interruptionWindowMs",
    scope: "Voice mode only",
    group: "Interruptions",
    label: "Interruption recognition window",
    min: 500,
    max: 8000,
    step: 250,
    unit: "ms",
    description:
      "Allow this much time for recognition to confirm an interruption. Unconfirmed speech is discarded, not queued.",
  },
] as const;

export type SpeechInputNumericSetting = (typeof speechInputControls)[number]["key"];
export type SpeechInputPreferences = Record<SpeechInputNumericSetting, number> & {
  shortCommands: boolean;
};
export const defaultSpeechInputPreferences: SpeechInputPreferences = {
  speechStartThreshold: 0.6,
  speechContinueThreshold: 0.4,
  minimumSpeechMs: 200,
  prerollMs: 600,
  sendPauseSeconds: 3,
  countdownDelaySeconds: 1,
  maximumUtteranceSeconds: 30,
  interruptionWords: 4,
  interruptionWindowMs: 3000,
  shortCommands: true,
};

/** Normalize window preferences without importing transport/Effect into Stores.
 * Bounds also protect restored snapshots; coupled dials remain internally valid. */
export function normalizeSpeechInputPreferences(
  input?: Partial<SpeechInputPreferences>,
): SpeechInputPreferences {
  const result = { ...defaultSpeechInputPreferences };
  for (const control of speechInputControls) {
    const value = Option.getOrElse(readNumber(input?.[control.key]), () => result[control.key]);
    const rounded = Math.round(value / control.step) * control.step;
    result[control.key] = Math.max(control.min, Math.min(control.max, Number(rounded.toFixed(3))));
  }
  result.shortCommands = Option.getOrElse(
    readBoolean(input?.shortCommands),
    () => result.shortCommands,
  );
  result.speechContinueThreshold = Math.min(
    result.speechContinueThreshold,
    result.speechStartThreshold,
  );
  result.countdownDelaySeconds = Math.min(
    result.countdownDelaySeconds,
    result.sendPauseSeconds - 0.25,
  );
  return result;
}

/** Only shared recognition controls cross to native ASR; voice-only policy stays in the renderer. */
export function speechRecognitionSettings(
  preferences: SpeechInputPreferences,
): SpeechRecognitionSettings {
  return {
    thresholds: {
      start: preferences.speechStartThreshold,
      continuation: preferences.speechContinueThreshold,
    },
    minimumSpeechMs: preferences.minimumSpeechMs,
    prerollMs: preferences.prerollMs,
    maximumUtteranceSeconds: preferences.maximumUtteranceSeconds,
  };
}

export function formatSpeechInputSetting(key: SpeechInputNumericSetting, value: number): string {
  const control = speechInputControls.find((item) => item.key === key)!;
  if (control.unit === "percent") return `${Math.round(value * 100)}%`;
  if (control.unit === "ms") return `${value} ms`;
  if (control.unit === "words") return `${value} words`;
  return `${Number(value.toFixed(2))} s`;
}
