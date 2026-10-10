import type { CakeChatPreferences } from "../../contracts/application/application-data";

/** Cake-owned preferences and utility-completion port; no Pi SDK values cross it. */
export interface CakeChatMemoryOptions {
  preferences(): CakeChatPreferences;
  summarize(input: { instructions: string; context: string; signal: AbortSignal }): Promise<string>;
}
