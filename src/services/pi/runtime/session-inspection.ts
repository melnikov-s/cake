import { Option, Schema } from "effect";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  SessionHistoryEntry,
  type SessionHistoryQuery,
} from "../../../domain/conversations/session-query-data";
import { stripResponseModeReminder } from "../../../domain/conversations/conversation-response-mode";
import { stripPresentationModeReminder } from "../../../domain/project-sessions/presentation-mode-reminders";
import { jsonValueSchema } from "../../../ipc/json-contract";
import { textFromContent } from "./session-projection";
import {
  toolCompactEntryType,
  toolCompactProvenanceEntryType,
  toolCompactProvenanceSchema,
} from "./tool-compaction-provenance";

type MutableHistoryEntry = {
  -readonly [Key in keyof SessionHistoryEntry]: SessionHistoryEntry[Key];
};

function projectEntry(entry: SessionEntry, active: boolean): MutableHistoryEntry {
  const base: MutableHistoryEntry = {
    entryId: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    type: entry.type,
    active,
  };
  if (entry.type === "message") {
    const message = entry.message;
    const tools: NonNullable<SessionHistoryEntry["tools"]>[number][] = [];
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall")
          tools.push({
            name: block.name,
            callId: block.id,
            arguments: JSON.stringify(block.arguments),
          });
      }
      base.stopReason = message.stopReason;
      if (message.errorMessage) base.error = message.errorMessage;
      base.model = { provider: message.provider, modelId: message.model };
    }
    if (message.role === "toolResult") {
      tools.push({ name: message.toolName, callId: message.toolCallId });
      base.isError = message.isError;
    }
    base.role = message.role;
    base.text = stripResponseModeReminder(
      stripPresentationModeReminder("content" in message ? textFromContent(message.content) : ""),
    );
    if (message.role === "bashExecution") {
      tools.push({ name: "bash", arguments: message.command });
      base.text = `${message.command}\n${message.output}`;
      base.exitCode = message.exitCode ?? null;
    }
    base.tools = tools;
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    base.text = entry.summary;
    if (entry.type === "compaction") {
      base.tokensBefore = entry.tokensBefore;
      base.firstKeptEntryId = entry.firstKeptEntryId;
    }
  } else if (entry.type === "custom_message") {
    base.customType = entry.customType;
    base.text = textFromContent(entry.content);
    if (entry.customType === toolCompactEntryType) base.type = "tool-compaction";
  } else if (entry.type === "custom") {
    base.customType = entry.customType;
    // Do not expose arbitrary hidden extension state as transcript content.
    base.text = entry.customType;
  } else if (entry.type === "model_change") {
    base.text = `${entry.provider}/${entry.modelId}`;
  } else if (entry.type === "thinking_level_change") {
    base.text = entry.thinkingLevel;
  } else if (entry.type === "session_info") {
    base.text = entry.name ?? "";
  } else if (entry.type === "label") {
    base.text = entry.label ?? "";
    base.targetEntryId = entry.targetId;
  }
  return base;
}

/** Filter before pagination and clipping; original evidence remains in Pi's tree. */
export function inspectSessionHistory(session: SessionManager, query: SessionHistoryQuery) {
  if (query.leafId && query.branch === "all")
    throw new Error("leafId cannot be combined with branch: all");
  if (query.leafId && !session.getEntry(query.leafId))
    throw new Error("The requested branch leaf does not exist");
  const after = query.after === undefined ? undefined : Date.parse(query.after);
  const before = query.before === undefined ? undefined : Date.parse(query.before);
  if (
    (after !== undefined && !Number.isFinite(after)) ||
    (before !== undefined && !Number.isFinite(before))
  )
    throw new Error("Invalid history timestamp");
  if (after !== undefined && before !== undefined && after > before)
    throw new Error("after must not be later than before");
  const activeIds = new Set(session.getBranch().map((entry) => entry.id));
  const entries = query.branch === "all" ? session.getEntries() : session.getBranch(query.leafId);
  const provenance = new Map<string, { sourceLeafId: string; replayedMessages: number }>();
  for (const entry of session.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== toolCompactProvenanceEntryType) continue;
    const decoded = Schema.decodeUnknownOption(toolCompactProvenanceSchema)(entry.data);
    if (Option.isSome(decoded))
      provenance.set(decoded.value.markerEntryId, {
        sourceLeafId: decoded.value.sourceLeafId,
        replayedMessages: decoded.value.mappings.length,
      });
  }
  const needle = query.query?.toLocaleLowerCase();
  const matched = entries.flatMap((entry) => {
    const timestamp = Date.parse(entry.timestamp);
    if (after !== undefined && timestamp < after) return [];
    if (before !== undefined && timestamp > before) return [];
    const projected = projectEntry(entry, activeIds.has(entry.id));
    const source = provenance.get(entry.id);
    if (source) Object.assign(projected, source);
    if (query.types && !query.types.some((type) => type === projected.type)) return [];
    if (query.roles && !query.roles.some((role) => role === projected.role)) return [];
    if (query.toolName && !projected.tools?.some((tool) => tool.name === query.toolName)) return [];
    const searchable = [
      projected.text,
      projected.error,
      ...(projected.tools?.flatMap((tool) => [tool.name, tool.arguments]) ?? []),
    ].join("\n");
    if (needle && !searchable.toLocaleLowerCase().includes(needle)) return [];
    return [projected];
  });
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  // Keep pages below the Cake tool result budget even with Unicode-heavy evidence.
  const maxChars = Math.min(query.maxChars ?? 4_000, Math.floor(128_000 / limit));
  const page = matched.slice(offset, offset + limit).map((entry) => {
    let truncated = false;
    let remaining = maxChars;
    const clip = (text: string) => {
      const clipped = text.slice(0, remaining);
      remaining -= clipped.length;
      truncated ||= clipped.length < text.length;
      return clipped;
    };
    const result = { ...entry };
    if (typeof result.text === "string") result.text = clip(result.text);
    if (typeof result.error === "string") result.error = clip(result.error);
    if (result.tools)
      result.tools = result.tools.map((tool) =>
        tool.arguments === undefined ? tool : { ...tool, arguments: clip(tool.arguments) },
      );
    return { ...result, truncated };
  });
  return Schema.decodeUnknownSync(jsonValueSchema)({
    leafId: session.getLeafId(),
    branch: query.branch ?? "active",
    queriedLeafId: query.leafId ?? session.getLeafId(),
    total: matched.length,
    offset,
    maxChars,
    nextOffset: offset + page.length < matched.length ? offset + page.length : null,
    entries: page.map((entry) => Schema.decodeUnknownSync(SessionHistoryEntry)(entry)),
  });
}
