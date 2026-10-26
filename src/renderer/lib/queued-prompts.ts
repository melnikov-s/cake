import type { UiPart } from "../../contracts/conversations/session-contract";
import type { QueuedPrompt } from "../stores/ChatStore";

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
