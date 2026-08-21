import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Maximum number of automatic continuations Cake issues when a provider ends a
 * turn with an empty response before giving up and leaving the failure visible.
 */
export const EMPTY_TURN_MAX_CONTINUATIONS = 5;

/** Notice part id used for the empty-turn auto-continuation status. */
export const EMPTY_TURN_NOTICE_PART_ID = "active-empty-turn";

/**
 * Prompt sent back to the model when it returns an empty response.
 */
export const emptyTurnContinuationPrompt =
  "Your previous response arrived completely empty: the provider returned no content at all. Continue exactly where you left off and produce your full response.";

/**
 * A provider can fail silently: the HTTP request succeeds and the response is
 * protocol-valid, but the assistant turn contains no text, no thinking, and no
 * tool calls. Pi classifies this as a normal end of turn, so its transient-error
 * auto-retry never fires. This predicate recognizes that signature.
 *
 * It is deliberately strict so that ordinary operation can never match:
 * - `stopReason` must be exactly "stop" (errors, aborts, length cutoffs,
 *   tool-use turns, pending/deferred turns are all excluded),
 * - an `errorMessage` on the message excludes it,
 * - any tool call excludes it,
 * - any text or thinking content that is not blank after trimming excludes it.
 * An empty content array matches (the observed failure shape).
 */
export function isEmptyAssistantTurn(message: AssistantMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "stop") return false;
  if (message.errorMessage) return false;
  return message.content.every(
    (part) =>
      part.type !== "toolCall" &&
      !(part.type === "text" && part.text.trim().length > 0) &&
      !(part.type === "thinking" && part.thinking.trim().length > 0),
  );
}

export type EmptyTurnDecision =
  | { action: "reset" }
  | { action: "continue"; attempt: number }
  | { action: "give-up"; attempts: number };

/**
 * Decide what to do after the agent settles, given the final assistant message
 * and how many consecutive empty-turn continuations were already issued.
 * Any substantive turn resets the counter; empty turns continue up to
 * EMPTY_TURN_MAX_CONTINUATIONS times, then give up visibly.
 */
export function decideEmptyTurnResponse(
  lastMessage: AssistantMessage | undefined,
  priorContinuations: number,
): EmptyTurnDecision {
  if (!isEmptyAssistantTurn(lastMessage)) return { action: "reset" };
  if (priorContinuations >= EMPTY_TURN_MAX_CONTINUATIONS)
    return { action: "give-up", attempts: priorContinuations };
  return { action: "continue", attempt: priorContinuations + 1 };
}
