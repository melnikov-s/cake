import type { CakeChatPreferences } from "../application/application-data";
export const defaultCakeChatPreferences = (): CakeChatPreferences => ({
  // Roughly 10k tokens for English summaries; bytes are the stable cross-model limit.
  memoryViewBytes: 40_000,
  instructions: "",
});
