import { Store, createStore } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { ReviewsStore } from "./ReviewsStore";
import { ChatStore } from "./ChatStore";

export interface MessageCommentsStoreProps {
  sessionRegistry: SessionRegistryStore;
  reviews(): ReviewsStore;
  draftChatStore(): ChatStore;
  context(): { sessionId: string } | undefined;
}

export interface MessageSelectionAnchor {
  messageId: string;
  entryId?: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  contextBefore: string;
  contextAfter: string;
}

/** Owns assistant-message annotation creation, replies, and thread visibility. */
export class MessageCommentsStore extends Store<MessageCommentsStoreProps> {
  draftSelection: MessageSelectionAnchor | undefined;
  createdThreadId: string | undefined;
  draftFocusRequestRevision = 0;

  get threads() {
    const context = this.props.context();
    if (!context) return [];
    return this.props.sessionRegistry.findModel(context.sessionId)?.reviewThreads
      .filter((thread) => thread.anchor.view === "message") ?? [];
  }

  threadsForMessage(messageId: string) {
    return this.threads.filter((thread) => thread.anchor.messageId === messageId);
  }

  threadStreaming(threadId: string) {
    return this.props.reviews().threadStreaming(threadId);
  }

  private get draftThread() {
    return this.createdThreadId ? this.threads.find((thread) => thread.id === this.createdThreadId) : undefined;
  }

  chatStore(threadId: string) { return this.props.reviews().chatStore(threadId); }

  prepareDraft(selection: MessageSelectionAnchor) {
    this.draftChatStore.setDraft("");
    this.draftSelection = selection;
    this.createdThreadId = undefined;
    this.draftFocusRequestRevision += 1;
  }

  get draftChatStore() { return this.props.draftChatStore(); }

  get draftChatStoreElement() {
    return createStore(ChatStore, {
      id: () => "message-comment-draft",
      parts: () => {
        const selection = this.draftSelection;
        if (!selection) return [];
        return [
          { id: `selection:${selection.messageId}:${selection.startOffset}:${selection.endOffset}`, kind: "text" as const, role: "user" as const, text: selection.selectedText, status: "complete" as const },
          ...(this.draftThread?.uiParts ?? [])
        ];
      },
      streaming: () => Boolean(this.createdThreadId && this.threadStreaming(this.createdThreadId)),
      submitting: () => false,
      configuration: () => this.props.reviews().configuration,
      commands: () => [],
      placeholder: () => "Ask Cake about this passage…",
      inputLabel: () => "Message about selected text",
      focusRequestRevision: () => this.draftFocusRequestRevision,
      canSubmit: (draft) => Boolean(this.draftSelection && draft.trim()) && !this.draftThread?.pending && (!this.createdThreadId || !this.threadStreaming(this.createdThreadId)),
      submit: async (draft) => {
        if (!this.draftSelection) return false;
        if (!this.createdThreadId) {
          const threadId = await this.createThread(this.draftSelection, draft);
          this.createdThreadId = threadId;
          return Boolean(threadId);
        }
        const reviews = this.props.reviews();
        const saved = await reviews.replyThread(this.createdThreadId, draft);
        if (saved) await reviews.submitThread(this.createdThreadId);
        return saved;
      },
      error: () => ({ message: this.props.reviews().error, details: this.props.reviews().errorDetails }),
      usage: () => this.draftThread?.usage
    });
  }

  async createThread(selection: MessageSelectionAnchor, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return undefined;
    const anchor: ReviewAnchor = {
      path: `session:${context.sessionId}/message/${selection.messageId}`,
      view: "message",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: selection.selectedText,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
      diff: "",
      messageId: selection.messageId,
      entryId: selection.entryId,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset
    };
    return this.props.reviews().createThread(anchor, body);
  }

}
