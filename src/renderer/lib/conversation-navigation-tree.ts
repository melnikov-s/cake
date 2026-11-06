import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { ProjectSessionSummary } from "../../contracts/project-sessions/project-session-data";
import type { CakeChatSummary } from "../../contracts/cake-chats/cake-chat-data";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { Conversation } from "../models/Conversation";
import type { SessionActivity } from "./session-activity";

export type ConversationNavigationTarget =
  | { readonly kind: "cake-chat" | "project-session"; readonly sessionId: string }
  | {
      readonly kind: "side-chat";
      readonly sessionId: string;
      readonly parentSessionId: string;
      readonly threadId: string;
    }
  | { readonly kind: "subagent"; readonly sessionId: string; readonly handleId: string };

export interface ConversationNavigationMetadataTarget {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly kind: "cake-chat" | "project-session" | "side-chat";
}

type ConversationRelationship = "home" | "grouped" | "family-child" | "side-chat" | "subagent";
export interface ConversationNavigationNode {
  readonly key: string;
  readonly title: string;
  readonly label:
    | "Project Chat"
    | "Cake Chat"
    | "Session"
    | "Child session"
    | "Side chat"
    | "Subagent";
  /** Grouping beneath Project Chat is not a Session Family edge. */
  readonly relationship: ConversationRelationship;
  readonly target: ConversationNavigationTarget;
  readonly parentKey: string | undefined;
  readonly modifiedAt: string;
  readonly activity: SessionActivity | undefined;
  readonly running: boolean;
  readonly runningDescendants: number;
  /** Released worker history remains navigable, without reactivating its resources. */
  readonly readOnly?: boolean;
  readonly children: readonly ConversationNavigationNode[];
}
export interface ConversationNavigationTree {
  readonly roots: readonly ConversationNavigationNode[];
  readonly byKey: ReadonlyMap<string, ConversationNavigationNode>;
  readonly total: number;
  readonly running: number;
}
export interface ConversationNavigationInput {
  readonly projectPath: string | undefined;
  readonly resolved?: boolean;
  readonly sessions: readonly Pick<
    ProjectSessionSummary,
    | "sessionId"
    | "title"
    | "projectPath"
    | "modifiedAt"
    | "familyParentSessionId"
    | "familyChildOrder"
    | "resolved"
    | "running"
    | "unread"
    | "recoveryIssue"
    | "latestTurnOutcome"
  >[];
  readonly cakeChats: readonly Pick<
    CakeChatSummary,
    "sessionId" | "title" | "projectPath" | "modifiedAt" | "resolved" | "unread"
  >[];
  readonly discussions: readonly DiscussionCatalog[];
  readonly subagents: readonly SubagentCatalog[];
  readonly conversations: readonly Conversation[];
}
export const conversationNavigationKey = (sessionId: string) => `session:${sessionId}`;
export const subagentNavigationKey = (parentSessionId: string, handleId: string) =>
  `subagent:${parentSessionId}:${handleId}`;
export const conversationNavigationTargetKey = (target: ConversationNavigationTarget) =>
  target.kind === "subagent"
    ? subagentNavigationKey(target.sessionId, target.handleId)
    : conversationNavigationKey(target.sessionId);

type MutableNode = Omit<
  ConversationNavigationNode,
  "children" | "runningDescendants" | "parentKey" | "relationship" | "label"
> & {
  children: MutableNode[];
  runningDescendants: number;
  parentKey: string | undefined;
  relationship: ConversationRelationship;
  label: ConversationNavigationNode["label"];
  order?: number;
};

/** Read-only projection of existing authority facts; never materializes conversations or infers private worker IDs. */
export function buildConversationNavigationTree(
  input: ConversationNavigationInput,
): ConversationNavigationTree {
  const byKey = new Map<string, MutableNode>();
  const conversations = new Map(
    input.conversations.map((conversation) => [conversation.sessionId, conversation]),
  );
  const ownRunning = (sessionId: string) => {
    const conversation = conversations.get(sessionId);
    return Boolean(conversation?.streaming || conversation?.activeTurnIds.length);
  };
  const home =
    input.projectPath === undefined
      ? input.cakeChats.find((chat) => chat.sessionId === CAKE_CHAT_SESSION_ID)
      : input.cakeChats.find((chat) => chat.projectPath === input.projectPath);
  const homeId = input.resolved
    ? undefined
    : (home?.sessionId ?? (input.projectPath === undefined ? CAKE_CHAT_SESSION_ID : undefined));
  const homeKey = homeId ? conversationNavigationKey(homeId) : undefined;
  if (homeId) {
    const running = ownRunning(homeId);
    byKey.set(homeKey!, {
      key: homeKey!,
      title: input.projectPath === undefined ? "Cake Chat" : "Project Chat",
      label: input.projectPath === undefined ? "Cake Chat" : "Project Chat",
      relationship: "home",
      target: { kind: "cake-chat", sessionId: homeId },
      parentKey: undefined,
      modifiedAt: home?.modifiedAt ?? "",
      activity: running ? "running" : home?.unread ? "unread" : undefined,
      running,
      runningDescendants: 0,
      children: [],
    });
  }
  for (const [catalogOrder, session] of input.sessions.entries()) {
    if (
      input.projectPath === undefined ||
      session.projectPath !== input.projectPath ||
      session.resolved !== (input.resolved ?? false)
    )
      continue;
    const running = ownRunning(session.sessionId) || session.running;
    const parentId = session.familyParentSessionId;
    const familyChild = Boolean(parentId && parentId !== session.sessionId);
    byKey.set(conversationNavigationKey(session.sessionId), {
      key: conversationNavigationKey(session.sessionId),
      title: session.title || "Session",
      label: familyChild ? "Child session" : "Session",
      relationship: familyChild ? "family-child" : "grouped",
      target: { kind: "project-session", sessionId: session.sessionId },
      parentKey: familyChild ? conversationNavigationKey(parentId!) : homeKey,
      modifiedAt: session.modifiedAt,
      running,
      activity: running
        ? "running"
        : session.recoveryIssue
          ? "blocked"
          : session.latestTurnOutcome === "failed"
            ? "error"
            : session.latestTurnOutcome === "aborted"
              ? "stopped"
              : session.unread
                ? "unread"
                : undefined,
      runningDescendants: 0,
      children: [],
      order: session.familyChildOrder ?? catalogOrder,
    });
  }
  // Side chats can themselves own further catalogs. Iterate until every reachable owner is projected.
  const pending = input.discussions
    .flatMap((catalog) =>
      catalog.metadataLoaded
        ? catalog.metadata
        : catalog.threads.map((thread) => ({
            id: thread.id,
            workingDirectory: thread.workingDirectory,
            createdAt: thread.createdAt,
            running: thread.sidecarSessionId ? ownRunning(thread.sidecarSessionId) : false,
            parentSessionId: thread.parentSessionId,
            sidecarSessionId: thread.sidecarSessionId,
            title:
              thread.anchor.selectedText ||
              thread.textParts.find((part) => part.role === "user")?.text ||
              "Side chat",
            status: thread.status,
            updatedAt: thread.updatedAt,
          })),
    )
    .filter((thread) => thread.status === "open" && thread.sidecarSessionId);
  let added = true;
  while (added) {
    added = false;
    for (const thread of pending) {
      const key = conversationNavigationKey(thread.sidecarSessionId!);
      const parentKey = conversationNavigationKey(thread.parentSessionId);
      if (byKey.has(key) || !byKey.has(parentKey)) continue;
      const running = ownRunning(thread.sidecarSessionId!) || thread.running;
      byKey.set(key, {
        key,
        title: thread.title,
        label: "Side chat",
        relationship: "side-chat",
        parentKey,
        target: {
          kind: "side-chat",
          sessionId: thread.sidecarSessionId!,
          parentSessionId: thread.parentSessionId,
          threadId: thread.id,
        },
        modifiedAt: thread.updatedAt,
        running,
        activity: running ? "running" : undefined,
        runningDescendants: 0,
        children: [],
      });
      added = true;
    }
  }
  for (const catalog of input.subagents) {
    const activities = catalog.metadataLoaded ? catalog.metadata : catalog.activities;
    for (const activity of activities) {
      const parentKey = conversationNavigationKey(activity.parentSessionId);
      const released =
        "released" in activity
          ? activity.released
          : catalog.releasedHandleIds.includes(activity.handleId);
      if (!byKey.has(parentKey)) continue;
      const running =
        !released &&
        (activity.streaming || activity.status === "queued" || activity.status === "running");
      const key = subagentNavigationKey(activity.parentSessionId, activity.handleId);
      byKey.set(key, {
        key,
        title: activity.task || "Subagent",
        readOnly: released,
        label: "Subagent",
        relationship: "subagent",
        parentKey,
        target: {
          kind: "subagent",
          sessionId: activity.parentSessionId,
          handleId: activity.handleId,
        },
        modifiedAt: "",
        running,
        activity: running ? "running" : activity.status === "error" ? "error" : undefined,
        runningDescendants: 0,
        children: [],
      });
    }
  }
  const roots: MutableNode[] = [];
  for (const node of byKey.values()) {
    const parent = node.parentKey ? byKey.get(node.parentKey) : undefined;
    if (parent) parent.children.push(node);
    else {
      // A parent outside this scope is not a family edge to Project Chat.
      if (node.relationship === "family-child" && homeKey) {
        node.parentKey = homeKey;
        byKey.get(homeKey)!.children.push(node);
      } else {
        node.parentKey = undefined;
        roots.push(node);
      }
    }
  }
  const count = (node: MutableNode): number => {
    node.children.sort((a, b) =>
      a.order !== undefined && b.order !== undefined
        ? a.order - b.order
        : a.order !== undefined
          ? 1
          : b.order !== undefined
            ? -1
            : b.modifiedAt.localeCompare(a.modifiedAt) || a.key.localeCompare(b.key),
    );
    node.runningDescendants = node.children.reduce((sum, child) => sum + count(child), 0);
    return node.runningDescendants + Number(node.running);
  };
  const running = roots.reduce((sum, node) => sum + count(node), 0);
  return { roots, byKey, total: byKey.size, running };
}

export function conversationNavigationLineage(
  tree: ConversationNavigationTree,
  key: string | undefined,
): readonly ConversationNavigationNode[] {
  const lineage: ConversationNavigationNode[] = [];
  let node = key ? tree.byKey.get(key) : undefined;
  while (node) {
    lineage.unshift(node);
    node = node.parentKey ? tree.byKey.get(node.parentKey) : undefined;
  }
  return lineage;
}

/** Search retains only matching conversations and their ancestors; expansion is a separate projection. */
export function matchingConversationNavigationKeys(
  tree: ConversationNavigationTree,
  query: string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const normalized = query.trim().toLocaleLowerCase();
  for (const node of tree.byKey.values()) {
    if (
      !normalized ||
      `${node.title} ${node.label} ${node.running ? "running" : "idle"}`
        .toLocaleLowerCase()
        .includes(normalized)
    )
      for (const ancestor of conversationNavigationLineage(tree, node.key)) keys.add(ancestor.key);
  }
  return keys;
}
