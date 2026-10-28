import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiTurnResult } from "../../../contracts/pi/turn-result-data";
import { parseCrossSessionMessage } from "../../../contracts/conversations/cross-session-message";
import { splitContextReminders } from "./session-context-reminders";
import { textFromContent } from "./session-projection";

/** Token limits of the model that answered; absent when the runtime has no model. */
export interface TurnModelLimits {
  readonly contextWindow: number;
  readonly maxTokens: number;
}

const count = (value: number) => value.toLocaleString("en-US");

/**
 * Why a response ended with a `length` stop. Pi treats a cut-off below the model's own
 * output cap as context pressure (the request had no room left), so this does too.
 */
export function lengthStopDiagnostic(
  message: Pick<AssistantMessage, "usage">,
  model: TurnModelLimits | undefined,
): string {
  const { input, output, cacheRead, cacheWrite } = message.usage;
  if (!model) return "The response was cut off at the model's token limit before it finished.";
  if (model.maxTokens > 0 && output >= model.maxTokens)
    return `Output limit reached: the response was cut off at the model's ${count(model.maxTokens)}-token output limit before it finished.`;
  const used = input + output + cacheRead + cacheWrite;
  return `Context exhausted: ${count(used)} of ${count(model.contextWindow)} context tokens were in use, so the response was cut off before it finished.`;
}

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
  resultEntryId?: () => string | undefined,
  modelLimits?: () => TurnModelLimits | undefined,
) {
  let finalAssistantResult: PiTurnResult | undefined;
  // undefined: no attributable input yet in this run; null: the local user.
  let respondsTo: string | null | undefined;
  return (event: AgentSessionEvent) => {
    if (event.type === "message_end" && event.message.role === "user") {
      finalAssistantResult = undefined;
      respondsTo = counterpart(textFromContent(event.message.content), respondsTo);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const errorMessage =
        event.message.errorMessage ??
        (event.message.stopReason === "length"
          ? lengthStopDiagnostic(event.message, modelLimits?.())
          : undefined);
      finalAssistantResult = {
        stopReason: event.message.stopReason,
        text: textFromContent(event.message.content),
        ...(errorMessage ? { errorMessage } : null),
        ...(respondsTo ? { respondsToSessionId: respondsTo } : null),
      };
    }
    if (event.type !== "agent_settled") return;
    if (finalAssistantResult) {
      const entryId = resultEntryId?.();
      for (const id of executingIds())
        emit(id, { ...finalAssistantResult, ...(entryId ? { entryId } : null) });
    }
    finalAssistantResult = undefined;
    respondsTo = undefined;
  };
}
