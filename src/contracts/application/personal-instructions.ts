import type { ApplicationState } from "./application-data";

/** Permanent chats retain their shared guidance in cakeChatPreferences.instructions.
 * Automations and the companion have their own roles, so receive only universal guidance.
 * Private subagents are delegated work, never heirs to the parent’s user/chat scope.
 */
export function personalInstructions(
  state: ApplicationState,
  scope: "user" | "delegated" | "global",
): string {
  const scoped =
    scope === "user"
      ? state.userSessionInstructions
      : scope === "delegated"
        ? state.delegatedSessionInstructions
        : "";
  return [
    state.globalCustomInstructions.trim() &&
      `## Personal global instructions\n\n${state.globalCustomInstructions.trim()}`,
    scoped.trim() && `## Personal ${scope}-session instructions\n\n${scoped.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
