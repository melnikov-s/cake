import { Schema } from "effect";

export const SettingsPageId = Schema.Literals([
  "cake-chat",
  "mcp",
  "widget-packages",
  "models",
  "providers",
  "images",
  "classifiers",
  "agent",
  "runtime",
  "network",
  "labels",
  "prompts",
  "appearance",
  "hotkeys",
  "editor",
  "voice",
  "screen-capture",
  "experimental",
]);
export type SettingsPageId = typeof SettingsPageId.Type;

/** Stable agent-facing setting identities, independent of labels and DOM structure.
 * Add further destinations alongside their UI and tool contracts, not arbitrary selectors. */
export const settingsDestinations = {
  "dictation.enabled": { page: "voice", targetId: "dictation-title" },
  "dictation.textProcessingMode": { page: "voice", targetId: "setting-text-processing" },
  "dictation.voiceSubmit": { page: "voice", targetId: "setting-dictation-voice-submit" },
  "dictation.submitPhrase": { page: "voice", targetId: "setting-dictation-voice-submit" },
  "dictation.vocabulary": { page: "voice", targetId: "setting-dictation-vocabulary" },
  "speechInput.detection": { page: "voice", targetId: "voice-speechStartThreshold" },
  "speechInput.advanced": { page: "voice", targetId: "advanced-voice-title" },
} as const satisfies Record<string, { page: SettingsPageId; targetId: string }>;

export const SettingsOpenInput = Schema.Union([
  Schema.Struct({ page: SettingsPageId }),
  Schema.Struct({
    setting: Schema.Literals(
      // SAFETY: keys come only from the closed, locally declared destination map above.
      Object.keys(settingsDestinations) as Array<keyof typeof settingsDestinations>,
    ),
  }),
]);
