import { Schema } from "effect";

const targetId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** Shared agent boundary for Project Session navigation in the invoking window. */
export const SessionNavigationInput = Schema.Struct({
  sessionId: targetId,
  messageId: Schema.optionalKey(targetId),
});

export const sessionNavigationHelp = {
  topic: "sessions",
  summary:
    "Open an existing Project Session in the invoking Cake window's active conversation pane, optionally at a transcript message.",
  guidance: [
    "Use a sessionId from sessions.list or an existing Project Session. An exact messageId may also target the permanent Cake Chat conversation.",
    "Uses ordinary window-local navigation: replaces the focused pane's conversation, or focuses the target's pane if it is already open. Never creates a session or a window.",
    "Enabled by default. The user can disable agent session navigation in Settings → Agent for this window; the preference persists across restarts.",
    "The permission is user-owned and cannot be changed by an agent. When disabled, offer a cake://session/<session-id> link for the user to open instead.",
  ],
  examples: [{ input: { sessionId: "target-session-id" } }],
  result:
    "Success returns {ok:true,command:'sessions.open',opened:{workspacePath,sessionId,messageId?}}. Invalid targets, disabled navigation, and failed opens return {ok:false,command:'sessions.open',error}.",
};
