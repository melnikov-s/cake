import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { ProjectSessionSummary } from "../../contracts/project-sessions/project-session-data";
import type { CakeChatSummary } from "../../contracts/cake-chats/cake-chat-data";
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
/** Identity and ownership labels do not depend on activity, ordering or descendants. */
export interface ConversationNavigationEntry {
  readonly key: string;
  readonly title: string;
  /** Grouping beneath Project Chat is not a Session Family edge. */
  readonly relationship: ConversationRelationship;
  readonly target: ConversationNavigationTarget;
}
export interface ConversationNavigationNode extends ConversationNavigationEntry {
  readonly label:
    | "Project Chat"
    | "Cake Chat"
    | "Session"
    | "Child session"
    | "Side chat"
    | "Subagent";
  readonly parentKey: string | undefined;
  readonly modifiedAt: string;
  readonly activity: SessionActivity | undefined;
  readonly running: boolean;
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
  readonly projectName?: string;
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
    "sessionId" | "title" | "projectPath" | "modifiedAt" | "resolved" | "unread" | "running"
  >[];
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
  "children" | "parentKey" | "relationship" | "label"
> & {
  children: MutableNode[];
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
    const running = ownRunning(homeId) || Boolean(home?.running);
    byKey.set(homeKey!, {
      key: homeKey!,
      title:
        input.projectPath === undefined
          ? "Cake Chat"
          : (input.projectName ?? home?.title ?? input.projectPath),
      label: input.projectPath === undefined ? "Cake Chat" : "Project Chat",
      relationship: "home",
      target: { kind: "cake-chat", sessionId: homeId },
      parentKey: undefined,
      modifiedAt: home?.modifiedAt ?? "",
      activity: running ? "running" : home?.unread ? "unread" : undefined,
      running,
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
      children: [],
      order: session.familyChildOrder ?? catalogOrder,
    });
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
    return node.children.reduce((sum, child) => sum + count(child), Number(node.running));
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
