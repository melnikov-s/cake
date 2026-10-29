import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { internalInputOrigins, isAutomaticInput } from "./internal-input-projection";
import { parseContextAttachmentBlocks, textFromContent } from "./session-projection";
import {
  sideChatInputReferenceIds,
  type SideChatHistory,
  type SideChatHistoryMessage,
} from "../side-chat-history";

/** Copied parent context belongs to the sidecar's system prompt, not these original messages. */
export function exportRegularSideChatHistory(
  sourceSessionId: string,
  entries: readonly SessionEntry[],
): SideChatHistory {
  const origins = internalInputOrigins(entries);
  const messages: SideChatHistoryMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const origin = origins.get(entry.id);
    if (isAutomaticInput(origin)) continue;
    const raw = textFromContent(message.content);
    const attachments =
      message.role === "user" ? parseContextAttachmentBlocks(raw).attachments : [];
    const text =
      message.role === "user"
        ? origin?._tag === "UserWithReminders" && origin.userText !== undefined
          ? origin.userText
          : attachments.length
            ? parseContextAttachmentBlocks(raw).text
            : raw
        : raw;
    const content: SideChatHistoryMessage["content"] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...(message.role === "user" && Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "image")
        : []),
    ];
    if (!content.length && !attachments.length) continue;
    messages.push({
      sourceEntryId: entry.id,
      role: message.role,
      timestamp: message.timestamp,
      content,
      attachments,
      markdown: false,
    });
  }
  return { sourceSessionId, messages, inputReferenceIds: sideChatInputReferenceIds(messages) };
}
