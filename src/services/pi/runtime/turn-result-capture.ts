import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiTurnResult } from "../../../contracts/pi/turn-result-data";
import { textFromContent } from "./session-projection";

/** Captures only this consumed run's final assistant message, never a historical snapshot tail. */
export function createTurnResultCapture(
  executingIds: () => ReadonlyArray<string>,
  emit: (turnId: string, result: PiTurnResult) => void,
) {
  let finalAssistantResult: PiTurnResult | undefined;
  return (event: AgentSessionEvent) => {
    if (event.type === "message_end" && event.message.role === "user")
      finalAssistantResult = undefined;
    if (event.type === "message_end" && event.message.role === "assistant")
      finalAssistantResult = {
        stopReason: event.message.stopReason,
        text: textFromContent(event.message.content),
        ...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : null),
      };
    if (event.type !== "agent_settled") return;
    if (finalAssistantResult) for (const id of executingIds()) emit(id, finalAssistantResult);
    finalAssistantResult = undefined;
  };
}
