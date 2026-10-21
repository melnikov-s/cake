import type { CakeChatPreferences } from "../application/application-data";
import type { CakeModelChoice } from "../model-presets/cake-model-selection";

/** Absent contextLimitTokens uses this limit, capped by the selected model window. */
export const DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS = 300_000;

/** The active-context limits offered by Settings and accepted from agents. */
export const CAKE_CHAT_CONTEXT_LIMIT_CHOICES = [
  32_000, 64_000, 128_000, 200_000, 300_000, 500_000, 1_000_000,
] as const;

/** The history-view budgets offered by Settings and accepted from agents. */
export const CAKE_CHAT_MEMORY_VIEW_CHOICES = [
  5_000, 10_000, 20_000, 40_000, 80_000, 128_000,
] as const;

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
