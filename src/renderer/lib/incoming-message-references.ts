import type { UiPart } from "../../contracts/conversations/session-contract";
import { sessionNotificationEntries } from "../../contracts/cake-chats/session-digest-reminder";
import { messageReferencesInText } from "../../contracts/conversations/message-reference-forwarding";

/** Incoming cards own their exact originals; recap links are navigation, not another report. */
export function incomingMessageReferences(parts: readonly UiPart[]): ReadonlySet<string> {
  return new Set(
    parts.flatMap((part) =>
      part.kind === "context"
        ? sessionNotificationEntries(part.text).flatMap((entry) =>
            entry.reference ? [entry.reference] : [],
          )
        : part.kind === "text" && (part.crossSession || part.subagentReport || part.agentSource)
          ? messageReferencesInText(part.text)
          : [],
    ),
  );
}
