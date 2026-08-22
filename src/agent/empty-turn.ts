import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Maximum number of automatic continuations Cake issues when a provider ends a
 * turn with an empty response before giving up and leaving the failure visible.
 */
export const EMPTY_TURN_MAX_CONTINUATIONS = 5;

/** Notice part id used for the empty-turn auto-continuation status. */
export const EMPTY_TURN_NOTICE_PART_ID = "active-empty-turn";

/** Notice part id used when resuming a turn interrupted by a teardown/crash. */
export const INTERRUPTED_TURN_NOTICE_PART_ID = "interrupted-turn-resume";

/** Notice part id used for the aborted-turn auto-continuation status. */
export const ABORTED_TURN_NOTICE_PART_ID = "active-aborted-turn";

/**
 * Prompt sent back to the model when a session reattaches after its previous
 * run was killed mid-task (crash, window teardown, plugin reload).
 */
export const interruptedTurnResumePrompt =
  "The previous turn was interrupted before you could respond; your earlier tool results are in the conversation above. Continue exactly where you left off.";

/**
 * Prompt sent back to the model when it returns an empty response.
 */
export const emptyTurnContinuationPrompt =
  "Your previous response arrived completely empty: the provider returned no content at all. Continue exactly where you left off and produce your full response.";

/**
 * Prompt sent back to the model when its response stream was cut off mid-turn
 * (stop reason "aborted") without a user-initiated stop.
 */
export const abortedTurnContinuationPrompt =
  "Your previous response was cut off mid-stream before you could finish. Continue exactly where you left off.";

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

/**
 * Recognizes a turn whose response stream was cut off mid-generation: the
 * assistant message is persisted with stopReason "aborted" and whatever partial
 * content had already streamed (thinking, text, or nothing), but no tool call
 * ever completed. Pi ends the turn normally at this point, so neither its
 * transient-error auto-retry nor Cake's empty-turn continuation applies, and
 * the turn stalls mid-sentence until the user nudges it.
 *
 * Messages containing a tool call are excluded: an aborted tool-use turn may
 * have unexecuted tool calls, and continuing over those is not safe.
 */
export function isAbortedAssistantTurn(message: AssistantMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "aborted") return false;
  return message.content.every((part) => part.type !== "toolCall");
}

export type AbortedTurnDecision =
  | { action: "reset" }
  | { action: "continue"; attempt: number }
  | { action: "give-up"; attempts: number };

/**
 * Decide what to do after a run settles on an aborted assistant message.
 * A user-initiated stop (tracked by the caller while the run was active) always
 * resets; otherwise an aborted turn continues up to EMPTY_TURN_MAX_CONTINUATIONS
 * times before giving up visibly, mirroring the empty-turn policy.
 */
export function decideAbortedTurnResponse(
  lastMessage: AssistantMessage | undefined,
  userInitiated: boolean,
  priorContinuations: number,
): AbortedTurnDecision {
  if (userInitiated || !isAbortedAssistantTurn(lastMessage)) return { action: "reset" };
  if (priorContinuations >= EMPTY_TURN_MAX_CONTINUATIONS)
    return { action: "give-up", attempts: priorContinuations };
  return { action: "continue", attempt: priorContinuations + 1 };
}

export type EmptyTurnDecision =
  | { action: "reset" }
  | { action: "continue"; attempt: number }
  | { action: "give-up"; attempts: number };

/**
 * Detects a turn that was interrupted mid-task: the conversation ends in tool
 * results the model never responded to. This shape only occurs when a run was
 * killed without unwinding normally (crash, silent runtime teardown).
 *
 * If the nearest preceding assistant message has stopReason "aborted", the run
 * was stopped intentionally and must not be resumed.
 */
export function shouldAutoResumeInterruptedTurn(
  messages: readonly { role: string; stopReason?: string }[],
): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "toolResult") return false;
  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i];
    if (!message) break;
    if (message.role === "assistant") return message.stopReason !== "aborted";
  }
  return true;
}

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
