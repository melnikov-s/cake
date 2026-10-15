import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  messageReference,
  type MessageListInput,
  type MessageListResult,
  type MessageMetadata,
  type MessageReadResult,
} from "../../../contracts/conversations/message-reference";
import { parseContextAttachmentBlocks, textFromContent } from "./session-projection";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

function metadata(
  session: SessionManager,
  entry: MessageEntry,
  activeIds: ReadonlySet<string>,
): MessageMetadata {
  const message = entry.message;
  const content = "content" in message ? message.content : "";
  const inputRefs =
    message.role === "user"
      ? parseContextAttachmentBlocks(textFromContent(content))
          .attachments.flatMap((attachment) =>
            attachment.kind === "input"
              ? [attachment]
              : "inputReference" in attachment && attachment.inputReference
                ? [attachment.inputReference]
                : [],
          )
          .slice(0, 20)
      : [];
  const ref = messageReference(session.getSessionId(), entry.id);
  return {
    ref,
    link: ref,
    sessionId: session.getSessionId(),
    entryId: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    role: message.role,
    active: activeIds.has(entry.id),
    inputRefs,
    hasImages: Array.isArray(content) && content.some((block) => block.type === "image"),
  };
}

/** Lists Pi identities, never body previews. Compaction does not rewrite these references. */
export function listMessageReferences(
  session: SessionManager,
  query: Omit<MessageListInput, "sessionId"> & { readonly entryId?: string },
): MessageListResult {
  const branch = query.branch ?? "active";
  const activeIds = new Set(session.getBranch().map((entry) => entry.id));
  const entries = (branch === "all" ? session.getEntries() : session.getBranch()).filter(
    (entry): entry is MessageEntry =>
      entry.type === "message" &&
      (query.entryId === undefined || entry.id === query.entryId) &&
      (!query.roles || query.roles.some((role) => role === entry.message.role)),
  );
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  const messages: MessageMetadata[] = [];
  let remaining = 64_000;
  for (const entry of entries.slice(offset, offset + limit)) {
    const message = metadata(session, entry, activeIds);
    const size = JSON.stringify(message).length;
    if (size > remaining && messages.length > 0) break;
    messages.push(message);
    remaining -= size;
  }
  return {
    sessionId: session.getSessionId(),
    branch,
    total: entries.length,
    offset,
    nextOffset: offset + messages.length < entries.length ? offset + messages.length : null,
    messages,
  };
}

/** Exact ID lookup across Pi's entire tree, including pre-compaction and inactive branches. */
export function readMessageReference(
  session: SessionManager,
  query: { entryId?: string; offset?: number; maxChars?: number },
): MessageReadResult {
  const entry = query.entryId ? session.getEntry(query.entryId) : undefined;
  if (!entry || entry.type !== "message")
    throw new Error("The referenced Pi message does not exist in this session");
  const message = entry.message;
  const content = "content" in message ? message.content : "";
  // Explicit reads include textual tool calls/results, but never inline image bytes.
  const rawText =
    message.role === "bashExecution"
      ? `${message.command}\n${message.output}`
      : typeof content === "string"
        ? content
        : content
            .map((block) => {
              if (block.type === "text") return block.text;
              if (block.type === "thinking") return block.thinking;
              if (block.type === "toolCall")
                return `${block.name} ${JSON.stringify(block.arguments)}`;
              return "";
            })
            .filter(Boolean)
            .join("\n");
  const text = message.role === "user" ? parseContextAttachmentBlocks(rawText).text : rawText;
  const offset = query.offset ?? 0;
  const maxChars = query.maxChars ?? 4_000;
  const page = text.slice(offset, offset + maxChars);
  const nextOffset = offset + page.length < text.length ? offset + page.length : null;
  return {
    message: metadata(session, entry, new Set(session.getBranch().map((item) => item.id))),
    text: page,
    totalChars: text.length,
    offset,
    nextOffset,
    truncated: offset > 0 || nextOffset !== null,
  };
}
