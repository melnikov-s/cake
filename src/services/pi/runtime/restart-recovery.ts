import { Option, Schema } from "effect";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PiTurnResult } from "../../../contracts/pi/turn-result-data";
import { parseCrossSessionMessage } from "../../../contracts/conversations/cross-session-message";
import { textFromContent } from "./session-projection";

export const recoveryInputEntryType = "cake.recovery-input";
const recoveryInputEntry = Schema.Struct({ turnId: Schema.String, timestamp: Schema.Number });

export type RestartDecision =
  | { kind: "pending" }
  | { kind: "resume" }
  | { kind: "settled"; result: PiTurnResult }
  | { kind: "blocked"; issue: string };

/** The Pi branch, not a saved running flag, decides whether work needs continuation. */
export function restartDecision(entries: readonly SessionEntry[], turnId: string): RestartDecision {
  const marker = entries.findLastIndex((entry) => {
    if (entry.type !== "custom" || entry.customType !== recoveryInputEntryType) return false;
    const data = Schema.decodeUnknownOption(recoveryInputEntry)(entry.data);
    return Option.isSome(data) && data.value.turnId === turnId;
  });
  if (marker < 0) return { kind: "pending" };
  const messages: Array<Extract<SessionEntry, { type: "message" }>["message"]> = [];
  let answered = false;
  for (const entry of entries.slice(marker + 1)) {
    // Steering can add several inputs before the same answer. A new input
    // after a terminal answer belongs to a different run, even if Cake had not
    // yet removed this input's recovery intent when the process stopped.
    if (
      answered &&
      (entry.type === "custom_message" ||
        (entry.type === "message" && entry.message.role === "user"))
    )
      break;
    if (entry.type !== "message") continue;
    messages.push(entry.message);
    if (entry.message.role === "assistant")
      answered = entry.message.stopReason === "stop" || entry.message.stopReason === "error";
  }
  const markerEntry = entries[marker];
  const data =
    markerEntry?.type === "custom"
      ? Schema.decodeUnknownOption(recoveryInputEntry)(markerEntry.data)
      : Option.none();
  // The marker is appended in Pi's pre-persistence user-message callback. No
  // generation/tool can have started when that message is not yet on disk.
  if (
    Option.isNone(data) ||
    messages[0]?.role !== "user" ||
    messages[0].timestamp !== data.value.timestamp
  )
    return { kind: "pending" };
  const outstanding = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant")
      for (const part of message.content) if (part.type === "toolCall") outstanding.add(part.id);
    if (message.role === "toolResult") outstanding.delete(message.toolCallId);
  }
  if (outstanding.size)
    return {
      kind: "blocked",
      issue:
        "Cake restarted before a tool result was saved. The tool may already have changed files or external state. Review the unfinished tool before continuing; it will not be replayed automatically.",
    };
  const tail = messages.at(-1);
  if (tail?.role === "assistant" && (tail.stopReason === "stop" || tail.stopReason === "error")) {
    const latestUser = messages.findLast((message) => message.role === "user");
    const sender =
      latestUser?.role === "user"
        ? parseCrossSessionMessage(textFromContent(latestUser.content))?.metadata.sender.sessionId
        : undefined;
    return {
      kind: "settled",
      result: {
        stopReason: tail.stopReason,
        text: textFromContent(tail.content),
        ...(tail.errorMessage ? { errorMessage: tail.errorMessage } : null),
        ...(sender ? { respondsToSessionId: sender } : null),
      },
    };
  }
  return { kind: "resume" };
}

export class RestartRecoveryBlockedError extends Error {
  override readonly name = "RestartRecoveryBlockedError";
}

export const restartResumePrompt =
  "Cake restarted while this task was active. Continue from the saved conversation and tool results, without repeating completed actions. Verify current state before any further mutation. Do not repeat messages or reports already sent. If a prior action has an uncertain outcome, inspect it or ask the user rather than replaying it.";
