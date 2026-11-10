import { Store, child, createStore } from "r-state-tree";
import type { ModelPreset, UiPart } from "../../contracts/conversations/session-contract";
import type { ReviewThread } from "../models/ReviewThread";
import type { Conversation } from "../models/Conversation";
import { ConversationSessionStore } from "./ConversationSessionStore";
import { ConversationHistoryStore } from "./ConversationHistoryStore";
import { SideChatMergeStore } from "./SideChatMergeStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface DiscussionSessionStoreProps {
  /** Cake-owned thread metadata from the parent's Discussion catalog. */
  thread: ReviewThread;
  /** The sidecar's live conversation, observed like any other Cake Session. */
  model: Conversation;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  setResolved(resolved: boolean): Promise<boolean>;
  /** Present only for user-created Project Chat / Cake Chat side chats. */
  parentBusy?(): boolean;
  sendQueuedToSideChat?(sessionId: string, partId: string): Promise<void>;
}

/**
 * One Discussion Session: thread metadata wrapped around the same shared
 * conversation workflow that Project Sessions and Cake Chat use, so a side
 * chat prompts, queues, steers, stops, edits, and configures identically.
 */
export class DiscussionSessionStore extends Store<DiscussionSessionStoreProps> {
  private transcriptConsumers = 0;

  get transcriptDemanded() {
    return this.transcriptConsumers > 0 || this.conversationSessionStore.interviewStore.waiting;
  }

  /** Views, embedded hosts and nonvisual workflows share one observation, not one per reader. */
  retainTranscript() {
    this.transcriptConsumers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.transcriptConsumers -= 1;
    };
  }

  get thread() {
    return this.props.thread;
  }

  get threadId() {
    return this.thread.id;
  }

  /** The sidecar Pi Session ID every shared conversation operation addresses. */
  get sessionId() {
    return this.props.model.sessionId;
  }

  get model() {
    return this.props.model;
  }

  get streaming() {
    return this.model.streaming;
  }

  get chatStore() {
    return this.conversationSessionStore.chatStore;
  }

  get configurationStore() {
    return this.conversationSessionStore.configurationStore;
  }

  @child
  get mergeStore(): SideChatMergeStore | undefined {
    if (!this.props.parentBusy) return undefined;
    return createStore(SideChatMergeStore, {
      thread: this.thread,
      parentBusy: this.props.parentBusy,
      sideChat: () => this.chatStore,
    });
  }

  resolve() {
    return this.props.setResolved(true);
  }

  reopen() {
    return this.props.setResolved(false);
  }

  @child
  get history(): ConversationHistoryStore {
    return createStore(ConversationHistoryStore, {
      model: this.model,
      retainTranscript: () => this.retainTranscript(),
    });
  }

  @child
  get conversationSessionStore(): ConversationSessionStore {
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      canSubmit: () => true,
      // The sidecar is retained by this window's observation; a command issued
      // before the first snapshot lands waits for it instead of racing it.
      ensureSessionActive: () => this.model.observedSnapshotRevision > 0 || Promise.resolve(true),
      composer: {
        renameSession: async () => {
          throw new Error("Side chats cannot be renamed");
        },
        toolPruneSession: async () => {
          throw new Error("Side chats do not support /toolprune");
        },
        editorText: (entryId) =>
          this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
      },
      configuration: {},
      chat: {
        retainTranscript: () => this.retainTranscript(),
        sendQueuedToSideChat: this.props.sendQueuedToSideChat,
        estimatedContextUsage: true,
        history: this.history,
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () =>
          this.thread.anchor.view === "message" || this.thread.anchor.view === "artifact"
            ? "Reply to selection side chat"
            : this.thread.anchor.view === "session"
              ? "Reply to side chat"
              : "Reply to code chat",
        leadingParts: () => this.anchorParts,
        suggestFiles: (prefix) =>
          this.conversationSessionStore.composerStore.draftStore.suggestFiles(prefix),
        rewordWorkingDirectory: () => this.thread.workingDirectory,
      },
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
    });
  }

  /** The selected code or passage the thread discusses, shown as its opening context. */
  private get anchorParts(): UiPart[] {
    const selectedText = this.thread.anchor.selectedText;
    return selectedText
      ? [
          {
            id: `anchor:${this.threadId}`,
            kind: "text",
            role: "user",
            text: selectedText,
            status: "complete",
          },
        ]
      : [];
  }
}
