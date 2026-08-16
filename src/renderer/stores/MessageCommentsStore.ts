import { Store, child, createStore } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { DesktopClient } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { ReviewsStore } from "./ReviewsStore";
import { describeError } from "../error-details";
import { ChatStore } from "./ChatStore";

export interface MessageCommentsStoreProps {
  client: Pick<DesktopClient, "createReviewThread">;
  sessionRegistry: SessionRegistryStore;
  reviews(): ReviewsStore;
  context(): { workspacePath: string; sessionId: string } | undefined;
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
  error: string | undefined;
  errorDetails: string | undefined;
  draftSelection: MessageSelectionAnchor | undefined;
  createdThreadId: string | undefined;

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
  get threads() {
    const context = this.props.context();
    if (!context) return [];
    return this.props.sessionRegistry.findModel(context.sessionId, context.workspacePath)?.reviewThreads
      .filter((thread) => thread.anchor.view === "message") ?? [];
  }

  threadsForMessage(messageId: string) {
    return this.threads.filter((thread) => thread.anchor.messageId === messageId);
  }

  threadStreaming(threadId: string) {
    return this.props.reviews().threadStreaming(threadId);
  }

  chatStore(threadId: string) { return this.props.reviews().chatStore(threadId); }

  prepareDraft(selection: MessageSelectionAnchor) {
    this.draftSelection = selection;
    this.createdThreadId = undefined;
    this.draftChatStore.setDraft("");
  }

  @child
  get draftChatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => "message-comment-draft",
      parts: () => [],
      streaming: () => false,
      submitting: () => false,
      configuration: () => this.props.reviews().configuration,
      commands: () => [],
      placeholder: () => "Ask Cake about this passage…",
      inputLabel: () => "Message about selected text",
      canSubmit: (draft) => Boolean(this.draftSelection && draft.trim()),
      submit: async (draft) => {
        if (!this.draftSelection) return false;
        const threadId = await this.createThread(this.draftSelection, draft);
        this.createdThreadId = threadId;
        return Boolean(threadId);
      },
      error: () => ({ message: this.error, details: this.errorDetails })
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
    try {
      const thread = await this.props.client.createReviewThread({ ...context, anchor, body: body.trim() });
      if (this.signal.aborted) return undefined;
      this.props.sessionRegistry.upsertReviewThread(thread);
      await this.props.reviews().submitThreads([thread.id]);
      return thread.id;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return undefined;
    }
  }

}
