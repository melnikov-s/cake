import type { CakeChatPreferences } from "../application/application-data";
import type { CakeModelChoice } from "../model-presets/cake-model-selection";

export const defaultCakeChatPreferences = (): CakeChatPreferences => ({
  // Deliberately small OptMem view: 40,000 UTF-8 bytes upper / 20,000 target.
  // Zoom retains detail; model-window admission may lower this budget further.
  memoryViewBytes: 40_000,
  instructions: "",
});

/** Cake Chat preferences that choose a model with the shared model-choice interface. */
export type CakeChatModelSetting = "summarizationModel" | "subagentDefaultModel";

/** Unstored defaults: an absent setting resolves to this source. */
export const cakeChatModelSettingDefaults = {
  summarizationModel: { source: "utility" },
  subagentDefaultModel: { source: "inherit" },
} as const satisfies Record<CakeChatModelSetting, CakeModelChoice>;
