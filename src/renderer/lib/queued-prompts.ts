import type { UiPart } from "../../contracts/conversations/session-contract";
import { describeCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import type { QueuedPrompt } from "../stores/ChatStore";

/** A worker's queued result reads as its titled outcome, not Cake's `Session <uuid>` lead line. */
export function queuedPromptText(entry: Pick<QueuedPrompt, "text" | "source">): string {
  if (!entry.source) return entry.text;
  const described = describeCrossSessionMessage(entry.text, entry.source);
  if (!described.outcome) return entry.text;
  const { sender } = entry.source;
  const title =
    sender.title === `Session ${sender.sessionId}`
      ? `Session ${sender.sessionId.slice(0, 8)}`
      : sender.title;
  const body = described.body.replace(/\s+/g, " ").trim();
  return `${title} — ${described.outcome}${body ? `: ${body}` : ""}`;
}

/** One projection and editability policy for Pi-accepted conversation inputs. */
export function queuedPrompts(parts: readonly UiPart[]): QueuedPrompt[] {
  return parts.flatMap((part) =>
    part.kind === "text" &&
    part.role === "user" &&
    (part.deliveryState === "queued" || part.deliveryState === "steering")
      ? [
          {
            id: part.id,
            text: part.text,
            itemId: part.queuedInput?.itemId,
            turnId: part.queuedInput?.turnId,
            command: part.queuedInput?.command,
            attachments: part.queuedInput?.attachments.slice() ?? [],
            renderUserMessageAsMarkdown:
              part.queuedInput?.renderUserMessageAsMarkdown ?? part.renderAs === "markdown",
            state: part.deliveryState,
            source: part.crossSession,
            provenance:
              part.crossSession ||
              part.subagentReport ||
              part.agentSource ||
              part.queuedInput?.internal === "SubagentCompletion" ||
              part.queuedInput?.internal === "AgentUpdate"
                ? "agent"
                : part.queuedInput?.internal === "AttentionItem"
                  ? "attention"
                  : part.queuedInput?.internal
                    ? "automatic"
                    : undefined,
            scheduled: part.scheduled,
            automatic: Boolean(part.queuedInput?.internal || part.subagentReport),
            editable:
              Boolean(part.queuedInput) &&
              !part.queuedInput?.command &&
              !part.queuedInput?.internal &&
              !part.subagentReport &&
              !part.crossSession &&
              !part.scheduled,
          },
        ]
      : [],
  );
}
