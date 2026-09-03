import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { handoffEntryType } from "./session-projection";

const transferredUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Counts the tool activity a handoff elides: tool results, tool calls, and
 * bash executions. A handoff that elides nothing stays faithful to its source
 * and needs no orientation preamble.
 */
function countStrippedToolActivity(source: SessionManager, assistantEntryId: string) {
  let stripped = 0;
  for (const entry of source.getBranch(assistantEntryId)) {
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

function handoffPreamble(
  parentSessionFile: string,
  parentSessionName: string | undefined,
  strippedToolActivity: number,
) {
  const origin = parentSessionName
    ? `named "${parentSessionName}", stored at ${parentSessionFile}`
    : `stored at ${parentSessionFile}`;
  return [
    `This session is a handoff from a previous Cake session ${origin}.`,
    `The conversation below contains the user's messages and the final text of each assistant reply; ${strippedToolActivity} tool calls and results were omitted to save context.`,
    "References to files edited, commands run, or output observed describe tool work whose results are not shown, so verify the current state on disk rather than assuming it from this transcript.",
    `The full original transcript is at ${parentSessionFile} if you need it.`,
  ].join(" ");
}

/**
 * Creates a parent-linked session containing only visible user and assistant
 * conversation through one completed assistant entry. When tool activity was
 * elided, the session opens with a handoff orientation preamble so the model
 * knows the transcript is abridged and where the full original lives.
 */
export function createConversationHandoff(
  source: SessionManager,
  assistantEntryId: string,
  configuration?: {
    readonly provider: string;
    readonly modelId: string;
    readonly thinkingLevel: string;
  },
) {
  const selected = source.getEntry(assistantEntryId);
  if (
    selected?.type !== "message" ||
    selected.message.role !== "assistant" ||
    !selected.message.content.some((block) => block.type === "text" && block.text.trim())
  )
    throw new Error("Handoff requires a completed assistant response");

  const parentSession = source.getSessionFile();
  if (!parentSession) throw new Error("The current session is not persisted");

  const target = SessionManager.create(source.getCwd(), source.getSessionDir(), { parentSession });
  const strippedToolActivity = countStrippedToolActivity(source, assistantEntryId);
  if (strippedToolActivity > 0)
    target.appendCustomMessageEntry(
      handoffEntryType,
      handoffPreamble(parentSession, source.getSessionName(), strippedToolActivity),
      true,
    );
  for (const entry of source.getBranch(assistantEntryId)) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      target.appendMessage(message);
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
    target.appendMessage(transferred);
  }

  // Pi owns executable session configuration. Persist it directly in the new
  // transcript so opening a handoff does not require booting a destination
  // runtime merely to append the same model and thinking-level entries.
  if (configuration) {
    target.appendModelChange(configuration.provider, configuration.modelId);
    target.appendThinkingLevelChange(configuration.thinkingLevel);
  }

  const sessionFile = target.getSessionFile();
  if (!sessionFile) throw new Error("Cake could not persist the handoff session");
  return { sessionId: target.getSessionId(), sessionFile };
}
