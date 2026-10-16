import type { UiPart } from "../../contracts/conversations/session-contract";

/** Exact part links win; entry links prefer the message text over its activity. */
export function linkedMessageTarget(parts: readonly UiPart[], messageId: string) {
  return (
    parts.find((part) => part.id === messageId) ??
    parts.find((part) => "entryId" in part && part.entryId === messageId) ??
    parts.find((part) => part.id.startsWith(`entry-${messageId}-`))
  );
}
