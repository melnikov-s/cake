import type { CakeChatPreferences } from "../application/application-data";
import type { CakeModelChoice } from "../model-presets/cake-model-selection";

export const defaultCakeChatPreferences = (): CakeChatPreferences => ({
  // Public OptMem chat-memory specification: 128 KB upper / 64 KB lower view.
  // Admission may lower this to fit the selected model's actual token window.
  memoryViewBytes: 128_000,
  instructions: "",
});

/** Cake Chat preferences that choose a model with the shared model-choice interface. */
export type CakeChatModelSetting = "summarizationModel" | "subagentDefaultModel";

/** Unstored defaults: an absent setting resolves to this source. */
export const cakeChatModelSettingDefaults = {
  summarizationModel: { source: "utility" },
  subagentDefaultModel: { source: "inherit" },
} as const satisfies Record<CakeChatModelSetting, CakeModelChoice>;
