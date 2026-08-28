import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message, Usage } from "@earendil-works/pi-ai";

const transferredUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Creates a parent-linked session containing only visible user and assistant
 * conversation through one completed assistant entry.
 */
export function createConversationHandoff(source: SessionManager, assistantEntryId: string) {
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

  const sessionFile = target.getSessionFile();
  if (!sessionFile) throw new Error("Cake could not persist the handoff session");
  return { sessionId: target.getSessionId(), sessionFile };
}
