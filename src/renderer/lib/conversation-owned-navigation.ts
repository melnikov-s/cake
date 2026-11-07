import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { Conversation } from "../models/Conversation";
import {
  conversationNavigationKey,
  subagentNavigationKey,
  type ConversationNavigationNode,
} from "./conversation-navigation-tree";

export interface OwnedConversationNavigationNode extends ConversationNavigationNode {
  readonly preview?: string;
}

/** Direct ownership only: side chats first, then public worker handles, including released history. */
export function conversationOwnedNavigation(
  sessionId: string,
  discussions: DiscussionCatalog | undefined,
  subagents: SubagentCatalog | undefined,
  conversations: readonly Conversation[],
): readonly OwnedConversationNavigationNode[] {
  const nodes: OwnedConversationNavigationNode[] = [];
  const ownRunning = (id: string) => {
    const conversation = conversations.find((conversation) => conversation.sessionId === id);
    return Boolean(conversation?.streaming || conversation?.activeTurnIds.length);
  };
  const threads = discussions?.metadataLoaded ? discussions.metadata : (discussions?.threads ?? []);
  for (const thread of threads) {
    if (
      thread.parentSessionId !== sessionId ||
      thread.status !== "open" ||
      !thread.sidecarSessionId
    )
      continue;
    const full = discussions?.threads.find((candidate) => candidate.id === thread.id);
    if (full && !["message", "artifact", "session"].includes(full.anchor.view)) continue;
    const running = ownRunning(thread.sidecarSessionId) || ("running" in thread && thread.running);
    nodes.push({
      key: conversationNavigationKey(thread.sidecarSessionId),
      title:
        thread.title ||
        ("anchor" in thread
          ? thread.anchor.selectedText ||
            thread.textParts.find((part) => part.role === "user")?.text
          : undefined) ||
        "Side chat",
      preview: full?.textParts.findLast((part) => part.role === "assistant")?.text,
      label: "Side chat",
      relationship: "side-chat",
      parentKey: conversationNavigationKey(sessionId),
      target: {
        kind: "side-chat",
        sessionId: thread.sidecarSessionId,
        parentSessionId: sessionId,
        threadId: thread.id,
      },
      modifiedAt: thread.updatedAt,
      running: Boolean(running),
      activity: running ? "running" : undefined,
      runningDescendants: 0,
      children: [],
    });
  }
  nodes.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  for (const worker of subagents?.metadataLoaded
    ? subagents.metadata
    : (subagents?.activities ?? [])) {
    if (worker.parentSessionId !== sessionId) continue;
    const released =
      "released" in worker
        ? worker.released
        : subagents!.releasedHandleIds.includes(worker.handleId);
    const running =
      !released && (worker.streaming || worker.status === "queued" || worker.status === "running");
    nodes.push({
      key: subagentNavigationKey(sessionId, worker.handleId),
      title: worker.task || "Subagent",
      label: "Subagent",
      relationship: "subagent",
      parentKey: conversationNavigationKey(sessionId),
      target: { kind: "subagent", sessionId, handleId: worker.handleId },
      modifiedAt: "",
      readOnly: released,
      preview: released ? "Resources released" : worker.status,
      running,
      activity: running
        ? "running"
        : worker.status === "error"
          ? "error"
          : worker.status === "aborted"
            ? "stopped"
            : undefined,
      runningDescendants: 0,
      children: [],
    });
  }
  return nodes;
}
