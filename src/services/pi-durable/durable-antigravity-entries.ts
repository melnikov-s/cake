import { defineEntry, type EntryRecord } from "@earendil-works/pi-durable";
import type { UiPart } from "../../contracts/conversations/session-contract";
import {
  antigravityParts,
  antigravityResponseType,
  type AntigravityTurnDetails,
} from "../pi/runtime/antigravity-transcript";

// User and external reply are originals in the same Durable transcript. The
// reply's model projection is labeled historical data, not a fabricated Pi API message.
export const AntigravityUserEntry = defineEntry<{ markdown: boolean }>("cake.antigravity.user/v1");
export const AntigravityReplyEntry = defineEntry<
  Omit<AntigravityTurnDetails, "segments"> & {
    segments: AntigravityTurnDetails["segments"][number][];
  }
>(antigravityResponseType);
export const isAntigravityOriginal = (entry: EntryRecord) =>
  AntigravityUserEntry.is(entry) || AntigravityReplyEntry.is(entry);

export function durableAntigravityOriginal(entry: EntryRecord) {
  const message = entry.model?.[0];
  if (message?.role !== "user") return undefined;
  if (AntigravityUserEntry.is(entry) && typeof message.content === "string")
    return { role: "user" as const, text: message.content, timestamp: message.timestamp };
  if (AntigravityReplyEntry.is(entry) && Array.isArray(message.content))
    return {
      role: "assistant" as const,
      text: message.content
        .slice(1)
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n"),
      timestamp: message.timestamp,
    };
}

export function durableAntigravityParts(entry: EntryRecord, markdown?: boolean): UiPart[] {
  const original = durableAntigravityOriginal(entry);
  if (!original) return [];
  const entryId = String(entry.id);
  if (AntigravityUserEntry.is(entry))
    return [
      {
        kind: "text",
        id: `entry-${entry.id}`,
        entryId,
        role: "user",
        status: "complete",
        text: original.text,
        ...((markdown ?? entry.data.markdown) ? { renderAs: "markdown" as const } : null),
      },
    ];
  if (!AntigravityReplyEntry.is(entry)) return [];
  const message = entry.model?.[0];
  if (message?.role !== "user" || !Array.isArray(message.content)) return [];
  return (
    antigravityParts({
      type: "custom_message",
      id: entryId,
      parentId: null,
      timestamp: new Date(original.timestamp).toISOString(),
      customType: antigravityResponseType,
      details: entry.data,
      display: true,
      content: message.content.flatMap((block) => (block.type === "text" ? [block] : [])),
    }) ?? []
  );
}
