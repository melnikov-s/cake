import { Schema } from "effect";

const targetId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** Shared agent boundary for conversation navigation in the invoking window. */
export const SessionNavigationInput = Schema.Struct({
  sessionId: targetId,
  messageId: Schema.optionalKey(targetId),
});

export const sessionNavigationHelp = {
  topic: "sessions",
  summary:
    "Open a Project Session or permanent Cake/Project Chat in the invoking Cake window, optionally at a transcript message.",
  guidance: [
    "Use a sessionId from sessions.list or the canonical projectChatId from projects.list/projects.info, including a fresh registered Project Chat that has never been opened.",
    "Opening selects the conversation; it does not send a user message or drain passive FYIs. FYIs appear as inspectable passive-update context with the next user message or the normal batch deadline, not as user-authored messages.",
    "Uses ordinary window-local navigation: replaces the focused pane's conversation, or focuses the target's pane if it is already open. Never creates a session or a window.",
    "Enabled by default. The user can disable agent session navigation in Settings → Agent for this window; the preference persists across restarts.",
    "The permission is user-owned and cannot be changed by an agent. When disabled, offer the target's deepLink from sessions.info or sessions.list for the user to open instead.",
  ],
  examples: [{ input: { sessionId: "target-session-id" } }],
  result:
    "Success returns {ok:true,command:'sessions.open',opened:{workspacePath,sessionId,messageId?}}. Invalid targets, disabled navigation, and failed opens return {ok:false,command:'sessions.open',error}.",
};
