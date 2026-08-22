import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Delay before the first automatic retry of a silently failed turn. */
export const TURN_RETRY_BASE_DELAY_MS = 2_000;

/**
 * Upper bound on the exponential backoff between retries. Retries never stop;
 * once the cap is reached they continue at most once per hour so an
 * unattended session still finishes as soon as the provider recovers.
 */
export const TURN_RETRY_MAX_DELAY_MS = 60 * 60 * 1_000;

/** Notice part id used for the turn-recovery retry status. */
export const TURN_RECOVERY_NOTICE_PART_ID = "turn-recovery";

/** Notice part id used when resuming a turn interrupted by a teardown/crash. */
export const INTERRUPTED_TURN_NOTICE_PART_ID = "interrupted-turn-resume";

/**
 * Prompt sent back to the model when a session reattaches after its previous
 * run was killed mid-task (crash, window teardown, plugin reload).
 */
export const interruptedTurnResumePrompt =
  "The previous turn was interrupted before you could respond; your earlier tool results are in the conversation above. Continue exactly where you left off.";

export type TurnFailureKind = "empty" | "aborted" | "error";

export interface TurnFailure {
  kind: TurnFailureKind;
  /** Human-readable description of what the provider did, surfaced in the UI. */
  detail: string;
}

/**
 * A provider can fail silently in three ways, and Pi ends the turn normally
 * for every one of them, so its transient-error auto-retry never fires:
 *
 * - "empty" — the HTTP request succeeds and the response is protocol-valid,
 *   but the assistant turn contains no text, no thinking, and no tool calls.
 * - "aborted" — the stream is cut off mid-generation without a user-initiated
 *   stop; the message persists whatever partial content had already streamed.
 * - "error" — the provider surfaces an error Pi's own transient retry has
 *   already given up on (or declined to retry).
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
 * Recognizes a turn whose response stream was cut off mid-generation. Messages
 * containing a tool call are excluded: an aborted tool-use turn may have
 * unexecuted tool calls, and continuing over those is not safe.
 */
export function isAbortedAssistantTurn(message: AssistantMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "aborted") return false;
  return message.content.every((part) => part.type !== "toolCall");
}

/**
 * Provider errors that will never succeed on retry no matter how long the
 * backoff waits. Matched against the persisted error message; anything that
 * looks transient (rate limits, 5xx, stream corruption, timeouts) stays
 * retryable.
 */
const permanentErrorPatterns = [
  /api key/i,
  /authentication/i,
  /unauthorized/i,
  /\b401\b/,
  /\b403\b/,
  /forbidden/i,
  /permission denied/i,
  /invalid request/i,
  /model not found/i,
  /no such model/i,
  /unknown model/i,
  /context (length|window)/i,
  /billing/i,
];

/**
 * Classify a settled assistant message as a retryable silent failure.
 * Returns undefined for every healthy shape, for user-initiated aborts, and
 * for permanently-failing errors (bad key, unknown model, …) that backoff
 * cannot fix.
 */
export function classifyTurnFailure(
  message: AssistantMessage | undefined,
  userInitiated = false,
): TurnFailure | undefined {
  if (!message || message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted") {
    if (userInitiated || !isAbortedAssistantTurn(message)) return undefined;
    return {
      kind: "aborted",
      detail:
        message.errorMessage?.trim() ||
        "The response stream was cut off before the model produced anything.",
    };
  }
  if (isEmptyAssistantTurn(message)) {
    return {
      kind: "empty",
      detail: "The provider returned a well-formed response with no content at all.",
    };
  }
  if (message.stopReason === "error") {
    const detail = message.errorMessage?.trim() || "The provider request failed.";
    if (permanentErrorPatterns.some((pattern) => pattern.test(detail))) return undefined;
    return { kind: "error", detail };
  }
  return undefined;
}

/**
 * Exponential backoff for retry `attempt` (1-based): doubles from
 * TURN_RETRY_BASE_DELAY_MS and saturates at TURN_RETRY_MAX_DELAY_MS.
 */
export function turnRetryDelayMs(attempt: number): number {
  const clamped = Math.max(1, Math.floor(attempt));
  return Math.min(TURN_RETRY_BASE_DELAY_MS * 2 ** (clamped - 1), TURN_RETRY_MAX_DELAY_MS);
}

/** Humanize a retry delay for notice copy ("5s", "2m 30s", "1h"). */
export function formatRetryDelay(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** Prompt sent back to the model when Cake retries a failed turn. */
export function turnRetryPrompt(kind: TurnFailureKind): string {
  switch (kind) {
    case "empty":
      return "Your previous response arrived completely empty: the provider returned no content at all. Continue exactly where you left off and produce your full response.";
    case "aborted":
      return "Your previous response was cut off mid-stream before you could finish. Continue exactly where you left off.";
    case "error":
      return "Your previous response failed with a provider error. Continue exactly where you left off.";
  }
}

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
