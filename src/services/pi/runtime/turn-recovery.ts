import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Cake makes at most one hidden continuation for a silently failed turn. */
export const TURN_RECOVERY_MAX_AUTO_CONTINUATIONS = 1;

/** Notice part id used when bounded silent-turn recovery gives up. */
export const TURN_RECOVERY_NOTICE_PART_ID = "turn-recovery";

export type TurnFailureKind = "empty" | "aborted";

export interface TurnFailure {
  kind: TurnFailureKind;
  detail: string;
}

/**
 * Detect a protocol-valid assistant response that contains no useful content.
 * Provider errors are deliberately excluded: Pi owns their bounded retry
 * policy, setting, cancellation, and transient-error classification.
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
 * Recognize a response stream cut off without a completed tool call. Continuing
 * over an unexecuted tool call is unsafe.
 */
export function isAbortedAssistantTurn(message: AssistantMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (message.stopReason !== "aborted") return false;
  return message.content.every((part) => part.type !== "toolCall");
}

/** Classify only silent response anomalies that Pi cannot retry itself. */
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
        "The response stream was cut off before the model completed its response.",
    };
  }
  if (isEmptyAssistantTurn(message)) {
    return {
      kind: "empty",
      detail: "The provider returned a well-formed response with no content at all.",
    };
  }
  return undefined;
}

/** Hidden model context used for Cake's single silent-turn continuation. */
export function turnRecoveryPrompt(kind: TurnFailureKind): string {
  return kind === "empty"
    ? "Your previous response arrived completely empty. Continue exactly where you left off and produce your full response."
    : "Your previous response was cut off mid-stream before you could finish. Continue exactly where you left off.";
}
