import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
  messageReference,
  type MessageListResult,
  type MessageMetadata,
  type MessageReadResult,
} from "../../contracts/conversations/message-reference";
import type { SessionInspectionQuery } from "../../contracts/conversations/session-query-data";
import { parseContextAttachmentBlocks, textFromContent } from "../pi/runtime/session-projection";
import { durableInputPresentation } from "./durable-input-presentation";

/** Original IDs are Pi Durable entry IDs, exactly as in the existing GUI history projection. */
function original(entry: EntryRecord) {
  if (!["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind)) return undefined;
  return entry.model?.find((message) => message.role !== "system");
}
function metadata(sessionId: string, entry: EntryRecord): MessageMetadata | undefined {
  const message = original(entry);
  if (!message) return undefined;
  const text = textFromContent(message.content);
  const attachments =
    message.role === "user"
      ? parseContextAttachmentBlocks(durableInputPresentation(text).body).attachments
      : [];
  const ref = messageReference(sessionId, String(entry.id));
  return {
    ref,
    link: ref,
    sessionId,
    entryId: String(entry.id),
    parentId: null,
    timestamp: new Date(message.timestamp).toISOString(),
    role: message.role,
    active: true,
    inputRefs: attachments.flatMap((item) => (item.kind === "input" ? [item] : [])).slice(0, 20),
    hasImages:
      typeof message.content !== "string" &&
      message.content.some((block) => block.type === "image"),
  };
}

/** Scan SDK originals, not compacted model context or a Cake transcript index. */
export async function listDurableMessageReferences(
  root: Pick<Conversation, "entries">,
  sessionId: string,
  query: SessionInspectionQuery,
): Promise<MessageListResult> {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  let cursor: Cursor | undefined;
  let total = 0;
  let remaining = 64_000;
  let collecting = true;
  const messages: MessageMetadata[] = [];
  do {
    const page = await root.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      const value = metadata(sessionId, entry);
      if (!value || (query.roles && !query.roles.some((role) => role === value.role))) continue;
      if (query.entryId && String(entry.id) !== query.entryId) continue;
      if (total >= offset && messages.length < limit && collecting) {
        const size = JSON.stringify(value).length;
        if (size <= remaining || messages.length === 0) {
          messages.push(value);
          remaining -= size;
        } else collecting = false;
      }
      total++;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return {
    sessionId,
    branch: query.branch ?? "active",
    total,
    offset,
    messages,
    nextOffset: offset + messages.length < total ? offset + messages.length : null,
  };
}

export async function readDurableMessageReference(
  root: Pick<Conversation, "entries">,
  sessionId: string,
  query: { entryId?: string; offset?: number; maxChars?: number },
): Promise<MessageReadResult> {
  const number = Number(query.entryId);
  if (
    !query.entryId ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    String(number) !== query.entryId
  )
    throw new Error("Invalid Pi Durable message reference");
  // SAFETY: Pi Durable IDs are branded positive integers; the exact canonical string was validated above.
  const id = number as EntryId;
  const page = await root.entries(
    { minEntryId: id, maxEntryId: id },
    1,
    undefined,
    BACKGROUND_CONTEXT,
  );
  const entry = page.items.find((item) => String(item.id) === query.entryId);
  const message = entry && original(entry);
  const identity = entry && metadata(sessionId, entry);
  if (!message || !identity) throw new Error("The referenced Pi Durable message does not exist");
  const raw = textFromContent(message.content);
  const text = message.role === "user" ? durableInputPresentation(raw).text : raw;
  const offset = query.offset ?? 0;
  const maxChars = query.maxChars ?? 4_000;
  if (offset > text.length) throw new Error("Message text offset is beyond the original content");
  const slice = text.slice(offset, offset + maxChars);
  const nextOffset = offset + slice.length < text.length ? offset + slice.length : null;
  return {
    message: identity,
    text: slice,
    totalChars: text.length,
    offset,
    nextOffset,
    truncated: offset > 0 || nextOffset !== null,
  };
}
