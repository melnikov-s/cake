import { Store, child, createStore, observable, snapshot } from "r-state-tree";
import type { ChatConfiguration } from "../../contracts/conversations/session-contract";
import type { CakeChatSummary } from "../../contracts/cake-chats/cake-chat-data";
import type { JsonObject } from "../../contracts/serialization/json-contract";
import { PendingConversationStore } from "./PendingConversationStore";

export type CakeChatSummaryProjection = CakeChatSummary & { draft?: boolean };

export interface CakeControlTool {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  parameters: JsonObject;
  examples?: readonly { input?: JsonObject; description?: string }[];
  result?: string;
  limitations?: readonly string[];
}

interface NewCakeChatSessionRequest {
  configuration?: ChatConfiguration;
}

export interface CakeChatPendingSessionsStoreProps {
  defaultConfiguration?(): ChatConfiguration | undefined;
}

/** Owns the Cake Chat pending collection and its pending-to-materialized lifecycle. */
export class CakeChatPendingSessionsStore extends Store<CakeChatPendingSessionsStoreProps> {
  @snapshot private readonly conversationIds: string[] = observable([]);
  @snapshot private readonly pendingSessionIds: string[] = observable([]);

  @child
  get conversations(): PendingConversationStore[] {
    return this.conversationIds.map((sessionId) =>
      createStore(PendingConversationStore, { key: sessionId, sessionId }),
    );
  }

  conversation(sessionId: string) {
    return this.conversations.find((conversation) => conversation.sessionId === sessionId);
  }

  get summaries(): readonly CakeChatSummaryProjection[] {
    return this.conversations.map((conversation) => ({
      sessionId: conversation.sessionId,
      title: conversation.title,
      createdAt: conversation.createdAt,
      modifiedAt: conversation.modifiedAt,
      messageCount: conversation.messageCount,
      resolved: conversation.resolved,
      unread: false,
      draft: conversation.isDraft,
    }));
  }

  firstUnstartedSessionId() {
    return this.pendingSessionIds[0];
  }

  create(sessionId: string, name?: string) {
    if (this.conversation(sessionId)) return false;
    this.conversationIds.push(sessionId);
    this.pendingSessionIds.push(sessionId);
    const conversation = this.conversation(sessionId)!;
    if (name !== undefined) conversation.name = name;
    return true;
  }

  remove(sessionId: string) {
    removeValue(this.conversationIds, sessionId);
    removeValue(this.pendingSessionIds, sessionId);
  }

  /** Drops renderer-pending metadata once the authoritative catalog contains the session. */
  reconcileMaterialized(authoritativeSessionIds: ReadonlySet<string>) {
    for (let index = this.conversationIds.length - 1; index >= 0; index -= 1) {
      const sessionId = this.conversationIds[index]!;
      if (authoritativeSessionIds.has(sessionId)) this.remove(sessionId);
    }
  }

  isPending(sessionId: string) {
    return this.pendingSessionIds.includes(sessionId);
  }

  configuration(sessionId: string) {
    return this.isPending(sessionId)
      ? (this.conversation(sessionId)?.configuration ?? this.props.defaultConfiguration?.())
      : undefined;
  }

  newSessionRequest(sessionId: string) {
    if (!this.isPending(sessionId)) return undefined;
    const request: NewCakeChatSessionRequest = {};
    const configuration = this.configuration(sessionId);
    if (configuration !== undefined) request.configuration = configuration;
    return request;
  }

  markMaterialized(sessionId: string) {
    if (!this.isPending(sessionId)) return;
    removeValue(this.pendingSessionIds, sessionId);
    this.conversation(sessionId)?.markMaterialized();
  }

  isResolved(sessionId: string) {
    return this.conversation(sessionId)?.resolved ?? false;
  }
}

function removeValue(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}
