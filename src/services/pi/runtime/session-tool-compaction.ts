import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  UserMessage,
  Usage,
  TextContent,
  ImageContent,
} from "@earendil-works/pi-ai";
import {
  toolCompactEntryType,
  toolCompactProvenanceEntryType,
  type ToolCompactProvenance,
} from "./tool-compaction-provenance";

import { splitContextReminders } from "./session-context-reminders";
import { parseCrossSessionMessage } from "../cross-session-message";

/** The sole replay policy: user-authored input and assistant text, no injected context. */
export function toolCompactDialogueMessage(
  entry: SessionEntry,
): UserMessage | AssistantMessage | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (message.role === "user") {
    const clean = (text: string) => splitContextReminders(text).text;
    const rawText =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    if (parseCrossSessionMessage(clean(rawText))) return undefined;
    const content =
      typeof message.content === "string"
        ? clean(message.content)
        : message.content.flatMap<TextContent | ImageContent>((block) => {
            if (block.type !== "text") return [block];
            const text = clean(block.text);
            return text.trim() ? [{ ...block, text }] : [];
          });
    if (typeof content === "string" ? !content.trim() : content.length === 0) return undefined;
    return { ...message, content };
  }
  if (message.role !== "assistant") return undefined;
  const content = message.content.filter(
    (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
      block.type === "text" && Boolean(block.text.trim()),
  );
  if (content.length === 0) return undefined;
  return {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    usage: transferredUsage,
    stopReason: "stop",
    timestamp: message.timestamp,
  };
}

const transferredUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function countStrippedToolActivity(sourceBranch: readonly SessionEntry[]) {
  let stripped = 0;
  for (const entry of sourceBranch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult" || message.role === "bashExecution") {
      stripped += 1;
      continue;
    }
    if (message.role === "assistant")
      stripped += message.content.filter((block) => block.type === "toolCall").length;
  }
  return stripped;
}

function toolCompactPreamble(strippedToolActivity: number) {
  return [
    "This conversation branch is a tool-compacted continuation of an earlier branch in this Cake session.",
    `The conversation below contains only user-authored input and assistant text; injected reminders, coordination and custom messages were removed, along with ${strippedToolActivity} tool calls and results to save context.`,
    "References to files edited, commands run, or output observed describe tool work whose results are not shown, so verify the current state on disk rather than assuming it from this transcript.",
    "The full original transcript remains available in the session tree if you need it.",
  ].join(" ");
}

function sourceBranch(session: SessionManager, assistantEntryId: string) {
  const selected = session.getEntry(assistantEntryId);
  if (
    selected?.type !== "message" ||
    selected.message.role !== "assistant" ||
    !selected.message.content.some((block) => block.type === "text" && block.text.trim())
  )
    throw new Error("Tool compaction requires a completed assistant response");
  return session.getBranch(assistantEntryId);
}

/**
 * Appends a root branch containing only user input and assistant text. Context
 * reminders, coordination, custom messages, reasoning and tool activity are removed. The
 * original branch remains in the same Pi JSONL tree and the Session ID is stable.
 */
export function appendToolCompactedBranch(
  session: SessionManager,
  assistantEntryId: string,
  configuration?: {
    readonly provider: string;
    readonly modelId: string;
    readonly thinkingLevel: string;
  },
) {
  const branch = sourceBranch(session, assistantEntryId);
  const strippedToolActivity = countStrippedToolActivity(branch);
  session.resetLeaf();
  // Orientation is display metadata, not another message in the clean model context.
  const markerEntryId = session.appendCustomEntry(toolCompactEntryType, {
    summary: toolCompactPreamble(strippedToolActivity),
  });
  const mappings: ToolCompactProvenance["mappings"][number][] = [];

  for (const entry of branch) {
    const message = toolCompactDialogueMessage(entry);
    if (!message) continue;
    mappings.push({ sourceEntryId: entry.id, replayedEntryId: session.appendMessage(message) });
  }

  const firstMapping = mappings[0];
  const lastMapping = mappings.at(-1);
  if (!firstMapping || !lastMapping)
    throw new Error("Cake could not map the tool-compacted dialogue replay");
  const provenance: ToolCompactProvenance = {
    version: 1,
    sourceLeafId: assistantEntryId,
    markerEntryId,
    replayStartEntryId: firstMapping.replayedEntryId,
    replayEndEntryId: lastMapping.replayedEntryId,
    mappings,
  };
  session.appendCustomEntry(toolCompactProvenanceEntryType, provenance);

  if (configuration) {
    session.appendModelChange(configuration.provider, configuration.modelId);
    session.appendThinkingLevelChange(configuration.thinkingLevel);
  }
  const leafId = session.getLeafId();
  if (!leafId) throw new Error("Cake could not append the tool-compacted branch");
  return {
    sessionId: session.getSessionId(),
    sessionFile: session.getSessionFile(),
    leafId,
  };
}
