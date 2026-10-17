import {
  convertToLlm,
  buildContextEntries,
  type AgentSession,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type {
  ContextInspection,
  ContextInspectionNode,
} from "../../../contracts/conversations/context-inspection";
import { contextMessage, contextSources } from "./context-outline";

export function projectContextInspection(
  session: Pick<AgentSession, "messages" | "systemPrompt" | "sessionManager">,
  cwd: string,
  tools: readonly unknown[],
): ContextInspection {
  const sources = contextSources(
    getCurrentSystemPrompt(session.messages) || session.systemPrompt,
    tools,
    cwd,
  );
  const memories: ContextInspectionNode[] = [];
  const messages: ContextInspectionNode[] = [];
  const branch = session.sessionManager.getBranch();
  for (const [index, message] of session.messages.entries()) {
    if (message.role === "system") continue;
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      const entry = branch.findLast(
        (entry) =>
          (entry.type === "compaction" || entry.type === "branch_summary") &&
          entry.summary === message.summary &&
          Date.parse(entry.timestamp) === message.timestamp,
      );
      const node: ContextInspectionNode = {
        id: `memory-${entry?.id ?? index}`,
        title: message.summary,
        kind: "summary",
      };
      memories.push(entry ? { ...node, source: entry.id, detail: { entryId: entry.id } } : node);
    } else {
      for (const [part, converted] of convertToLlm([message]).entries())
        messages.push(
          contextMessage(`message-${index}-${part}`, converted.role, converted.content),
        );
    }
  }
  if (messages.length) sources.push({ id: "messages", title: "Messages", children: messages });
  if (memories.length) sources.push({ id: "memory", title: "Memory", children: memories });
  return { sources };
}

/** Read only the originals covered by this summary, not unrelated session branches. */
export function projectMemoryDetail(
  manager: SessionManager,
  entryId: string,
  offset = 0,
): ContextInspection {
  const summary = manager.getEntry(entryId);
  if (!summary || (summary.type !== "compaction" && summary.type !== "branch_summary"))
    throw new Error("This memory no longer has an available source summary");
  let entries;
  if (summary.type === "compaction") {
    const ancestors = summary.parentId ? manager.getBranch(summary.parentId) : [];
    const context = buildContextEntries(ancestors, summary.parentId);
    const firstKept = context.findIndex((entry) => entry.id === summary.firstKeptEntryId);
    entries = firstKept < 0 ? context : context.slice(0, firstKept);
  } else {
    const shared = new Set(manager.getBranch(entryId).map((entry) => entry.id));
    entries = manager.getBranch(summary.fromId).filter((entry) => !shared.has(entry.id));
  }
  const readable = entries.filter(
    (entry) =>
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary",
  );
  const sources: ContextInspectionNode[] = readable.slice(offset, offset + 100).map((entry) => {
    if (entry.type === "compaction" || entry.type === "branch_summary")
      return {
        id: `history-${entry.id}`,
        title: entry.summary,
        kind: "summary",
        source: entry.id,
        detail: { entryId: entry.id },
      };
    if (entry.type === "custom_message")
      return {
        ...contextMessage(`history-${entry.id}`, entry.customType, entry.content),
        source: entry.id,
      };
    if (entry.type === "message")
      return {
        ...contextMessage(
          `history-${entry.id}`,
          entry.message.role,
          "content" in entry.message ? entry.message.content : entry.message,
        ),
        source: entry.id,
      };
    throw new Error("Unsupported summary source");
  });
  if (offset + 100 < readable.length)
    sources.push({
      id: `more-${entryId}-${offset + 100}`,
      title: "More messages",
      detail: { entryId, offset: offset + 100 },
    });
  return { sources };
}
