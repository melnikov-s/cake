import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { toolCompactEntryType } from "./session-projection";

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
    `The conversation below contains the user's messages and the final text of each assistant reply; ${strippedToolActivity} tool calls and results were omitted to save context.`,
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
 * Appends a root branch containing visible dialogue without tool activity. The
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
  if (strippedToolActivity > 0)
    session.appendCustomMessageEntry(
      toolCompactEntryType,
      toolCompactPreamble(strippedToolActivity),
      true,
    );

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      session.appendMessage(message);
      continue;
    }
    if (message.role !== "assistant") continue;
    const content = message.content.filter(
      (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
        block.type === "text" && Boolean(block.text.trim()),
    );
    if (content.length === 0) continue;
    const transferred: Message = {
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
    session.appendMessage(transferred);
  }

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
