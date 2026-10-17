import { Store, child, computed, createStore } from "r-state-tree";
import {
  hasSidecarConversation,
  type CakeChatSideChatStartInput,
  type DiscussionAnchor,
} from "../../contracts/discussion-sessions/discussion-session-data";
import type { Annotation, ModelPreset } from "../../contracts/conversations/session-contract";
import type { Conversation } from "../models/Conversation";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import { describeError } from "../lib/error-details";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ClientContext } from "./context/ClientContext";
import { DiscussionSessionStore } from "./DiscussionSessionStore";
import type { MessageSideChatHost } from "./MessageCommentsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface CakeChatSideChatsStoreProps {
  /** Cake-owned side chat metadata for the permanent Cake Chat. */
  catalog: DiscussionCatalog;
  /** The live conversation Model for one side chat's sidecar (created on demand). */
  discussionSessionModel(
    sessionId: string,
    workingDirectory: string,
    parentSessionId: string,
  ): Conversation;
  /** Cake Chat's own model; a new side chat starts on it. */
  parent(): Conversation;
  configuration(): ChatConfigurationStore;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/**
 * Side chats branched from Cake Chat messages: starting them, one shared
 * Discussion Session conversation Store per live thread, and resolution.
 */
export class CakeChatSideChatsStore
  extends Store<CakeChatSideChatsStoreProps>
  implements MessageSideChatHost
{
  error: string | undefined;
  errorDetails: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  get configuration() {
    return this.props.configuration();
  }

  /** Open side chats, most recently active first. */
  @computed
  get openThreads() {
    return this.props.catalog.threads
      .filter((thread) => thread.status === "open")
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  @child
  get discussionSessions(): DiscussionSessionStore[] {
    return this.props.catalog.threads.filter(hasSidecarConversation).map((thread) =>
      createStore(DiscussionSessionStore, {
        key: thread.id,
        thread,
        model: this.props.discussionSessionModel(
          thread.sidecarSessionId!,
          thread.workingDirectory,
          thread.parentSessionId,
        ),
        operations: this.props.operations,
        modelPresets: this.props.modelPresets,
        openModelPresetSettings: this.props.openModelPresetSettings,
        settings: this.props.settings,
        setResolved: (resolved) => this.resolveThread(thread.id, resolved),
      }),
    );
  }

  discussionSession(threadId: string) {
    return this.discussionSessions.find((session) => session.threadId === threadId);
  }

  chatStore(threadId: string) {
    return this.discussionSession(threadId)?.chatStore;
  }

  threadStreaming(threadId: string) {
    return this.discussionSession(threadId)?.streaming ?? false;
  }

  /** Starts a side chat on Cake Chat's current model; it then moves on its own. */
  async createThread(anchor: DiscussionAnchor, body: string, annotations: Annotation[] = []) {
    if (!body.trim() && annotations.length === 0) return undefined;
    this.clearError();
    const parent = this.props.parent();
    const input: CakeChatSideChatStartInput = {
      parentSessionId: parent.sessionId,
      anchor,
      text: body.trim(),
      annotations: [...annotations],
    };
    if (parent.model)
      Object.assign(input, {
        model: { provider: parent.model.provider, id: parent.model.modelId },
        thinkingLevel: parent.thinkingLevel,
      });
    try {
      const accepted = await this.client.cakeChats.startSideChat(input, { signal: this.signal });
      return this.signal.aborted ? undefined : accepted.thread.id;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return undefined;
    }
  }

  async resolveThread(threadId: string, resolved = true) {
    const thread = this.props.catalog.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return false;
    this.clearError();
    try {
      await this.client.discussionSessions.setResolved(
        {
          parentSessionId: thread.parentSessionId,
          workingDirectory: thread.workingDirectory,
          threadId,
          resolved,
        },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
