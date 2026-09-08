import { Store, child, createStore, observable } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { Annotation } from "../../ipc/session-contract";
import { applyAnnotationUpdate, createAnnotation } from "../../utils/annotations";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { ReviewsStore } from "./ReviewsStore";
import { ChatStore } from "./ChatStore";

export interface MessageCommentsStoreProps {
  sessionRegistry: SessionRegistryStore;
  reviews(): ReviewsStore;
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
  readonly draftAnnotations: Annotation[] = observable([]);

  get threads() {
    const context = this.props.context();
    if (!context) return [];
    return (
      this.props.sessionRegistry
        .findModel(context.sessionId)
        ?.reviewThreads.filter((thread) => thread.anchor.view === "message") ?? []
    );
  }

  threadsForMessage(messageId: string) {
    return this.threads.filter((thread) => thread.anchor.messageId === messageId);
  }

  threadStreaming(threadId: string) {
    return this.props.reviews().threadStreaming(threadId);
  }

  private get draftThread() {
    return this.createdThreadId
      ? this.threads.find((thread) => thread.id === this.createdThreadId)
      : undefined;
  }

  chatStore(threadId: string) {
    return this.props.reviews().chatStore(threadId);
  }

  prepareDraft(selection: MessageSelectionAnchor) {
    this.draftChatStore.setDraft("");
    this.draftAnnotations.splice(0);
    this.draftSelection = selection;
    this.createdThreadId = undefined;
    this.draftFocusRequestRevision += 1;
  }

  @child
  get draftChatStore(): ChatStore {
    return createStore(ChatStore, {
      key: "message-comment-draft",
      id: () => "message-comment-draft",
      parts: () => {
        const selection = this.draftSelection;
        if (!selection) return [];
        return [
          {
            id: `selection:${selection.messageId}:${selection.startOffset}:${selection.endOffset}`,
            kind: "text" as const,
            role: "user" as const,
            text: selection.selectedText,
            status: "complete" as const,
          },
          ...(this.draftThread?.uiParts ?? []),
        ];
      },
      streaming: () => Boolean(this.createdThreadId && this.threadStreaming(this.createdThreadId)),
      submitting: () => false,
      configuration: () => this.props.reviews().configuration,
      commands: () => [],
      placeholder: () => "Ask Cake about this passage…",
      inputLabel: () => "Message about selected text",
      focusRequestRevision: () => this.draftFocusRequestRevision,
      canSubmit: (draft) =>
        Boolean(this.draftSelection && (draft.trim() || this.draftAnnotations.length)) &&
        !this.draftThread?.pending &&
        (!this.createdThreadId || !this.threadStreaming(this.createdThreadId)),
      submit: async (draft) => {
        if (!this.draftSelection) return false;
        if (!this.createdThreadId) {
          const threadId = await this.createThread(this.draftSelection, draft);
          this.createdThreadId = threadId;
          if (threadId) this.draftAnnotations.splice(0);
          return Boolean(threadId);
        }
        const submitted = await this.props
          .reviews()
          .replyThread(this.createdThreadId, draft, this.draftAnnotations);
        if (submitted) this.draftAnnotations.splice(0);
        return submitted;
      },
      annotations: () => this.draftAnnotations,
      addAnnotation: (annotation) => this.addAnnotation(annotation),
      updateAnnotation: (id, update) => this.updateAnnotation(id, update),
      removeAnnotation: (id) => this.removeAnnotation(id),
      error: () => ({
        message: this.props.reviews().error,
        details: this.props.reviews().errorDetails,
      }),
      usage: () => this.draftThread?.usage,
    });
  }

  async createThread(
    selection: MessageSelectionAnchor,
    body: string,
    annotations: readonly Annotation[] = this.draftAnnotations,
  ) {
    const context = this.props.context();
    if (!context || (!body.trim() && annotations.length === 0)) return undefined;
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
      endOffset: selection.endOffset,
    };
    return this.props.reviews().createThread(anchor, body, annotations);
  }

  private addAnnotation(annotation: Omit<Annotation, "id">) {
    if (this.draftAnnotations.length >= 100) return;
    this.draftAnnotations.push(createAnnotation(crypto.randomUUID(), annotation));
  }

  private updateAnnotation(id: string, update: Partial<Omit<Annotation, "id">>) {
    const index = this.draftAnnotations.findIndex((annotation) => annotation.id === id);
    const annotation = this.draftAnnotations[index];
    if (index >= 0 && annotation)
      this.draftAnnotations.splice(index, 1, applyAnnotationUpdate(annotation, update));
  }

  private removeAnnotation(id: string) {
    const index = this.draftAnnotations.findIndex((annotation) => annotation.id === id);
    if (index >= 0) this.draftAnnotations.splice(index, 1);
  }
}
