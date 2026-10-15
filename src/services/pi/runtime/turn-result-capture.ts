import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiTurnResult } from "../../../contracts/pi/turn-result-data";
import { parseCrossSessionMessage } from "../../../contracts/conversations/cross-session-message";
import { splitContextReminders } from "./session-context-reminders";
import { textFromContent } from "./session-projection";

/**
 * The conversational counterpart a newly consumed user message makes the next
 * answer address. Replies and generated notices answer this session's own
 * coordination, so they keep the current counterpart instead of replacing it.
 */
const counterpart = (content: string, current: string | null | undefined) => {
  const message = parseCrossSessionMessage(splitContextReminders(content).text);
  if (!message) return null;
  if (message.metadata.replyToMessageId || message.metadata.generatedNotice) return current;
  return message.metadata.sender.sessionId;
};

/** Captures only this consumed run's final assistant message, never a historical snapshot tail. */
export function createTurnResultCapture(
  executingIds: () => ReadonlyArray<string>,
  emit: (turnId: string, result: PiTurnResult) => void,
) {
  let finalAssistantResult: PiTurnResult | undefined;
  // undefined: no attributable input yet in this run; null: the local user.
  let respondsTo: string | null | undefined;
  return (event: AgentSessionEvent) => {
    if (event.type === "message_end" && event.message.role === "user") {
      finalAssistantResult = undefined;
      respondsTo = counterpart(textFromContent(event.message.content), respondsTo);
    }
    if (event.type === "message_end" && event.message.role === "assistant")
      finalAssistantResult = {
        stopReason: event.message.stopReason,
        text: textFromContent(event.message.content),
        ...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : null),
        ...(respondsTo ? { respondsToSessionId: respondsTo } : null),
      };
    if (event.type !== "agent_settled") return;
    if (finalAssistantResult) for (const id of executingIds()) emit(id, finalAssistantResult);
    finalAssistantResult = undefined;
    respondsTo = undefined;
  };
}
