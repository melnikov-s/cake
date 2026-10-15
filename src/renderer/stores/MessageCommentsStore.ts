import { Store, child, createStore } from "r-state-tree";
import type { ReviewAnchor } from "../../contracts/reviews/review-contract";
import type { Annotation } from "../../contracts/conversations/session-contract";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import { AnnotationDraftStore } from "./AnnotationDraftStore";

/**
 * The Discussion Session workflow that owns a parent's message side chats:
 * Project Sessions use the window's Reviews Store, Cake Chat its own side chats.
 */
export interface MessageSideChatHost {
  readonly configuration: ChatConfigurationStore | undefined;
  readonly error: string | undefined;
  readonly errorDetails: string | undefined;
  chatStore(threadId: string): ChatStore | undefined;
  createThread(
    anchor: ReviewAnchor,
    body: string,
    annotations: Annotation[],
  ): Promise<string | undefined>;
}

export interface MessageCommentsStoreProps {
  catalog(sessionId: string): DiscussionCatalog | undefined;
  host(): MessageSideChatHost;
  context(): { sessionId: string } | undefined;
  /** The selection draft became a Discussion Session; its chat can take over. */
  onThreadCreated?(threadId: string): void;
}

export interface MessageSelectionAnchor {
  messageId: string;
  artifactId?: string;
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
    return (
      this.props
        .catalog(context.sessionId)
        ?.threads.filter((thread) => thread.anchor.view === "message") ?? []
    );
  }

  threadsForMessage(messageId: string) {
    return this.threads.filter((thread) => thread.anchor.messageId === messageId);
  }

  chatStore(threadId: string) {
    return this.props.host().chatStore(threadId);
  }

  prepareDraft(selection: MessageSelectionAnchor) {
    this.draftChatStore.setDraft("");
    this.annotationDraft.clear();
    this.draftSelection = selection;
    this.createdThreadId = undefined;
    this.draftFocusRequestRevision += 1;
  }

  @child
  get annotationDraft(): AnnotationDraftStore {
    return createStore(AnnotationDraftStore);
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
        ];
      },
      streaming: () => false,
      // Once the thread exists its own conversation Store takes over the side
      // chat; the draft only bridges the moment until the catalog lists it.
      submitting: () => Boolean(this.createdThreadId),
      configuration: () => this.props.host().configuration,
      commands: () => [],
      placeholder: () => "Ask Cake about this passage…",
      inputLabel: () => "Message about selected text",
      focusRequestRevision: () => this.draftFocusRequestRevision,
      canSubmit: (draft) =>
        Boolean(
          this.draftSelection &&
          !this.createdThreadId &&
          (draft.trim() || this.annotationDraft.annotations.length),
        ),
      submit: async (draft) => {
        if (!this.draftSelection || this.createdThreadId) return false;
        const threadId = await this.createThread(
          this.draftSelection,
          draft,
          this.annotationDraft.annotations,
        );
        this.createdThreadId = threadId;
        if (threadId) {
          this.annotationDraft.clear();
          this.props.onThreadCreated?.(threadId);
        }
        return Boolean(threadId);
      },
      annotations: () => this.annotationDraft.annotations,
      addAnnotation: (annotation) => this.annotationDraft.add(annotation),
      updateAnnotation: (id, update) => this.annotationDraft.update(id, update),
      removeAnnotation: (id) => this.annotationDraft.remove(id),
      error: () => ({
        message: this.props.host().error,
        details: this.props.host().errorDetails,
      }),
    });
  }

  async createThread(
    selection: MessageSelectionAnchor,
    body: string,
    annotations: readonly Annotation[] = this.annotationDraft.annotations,
  ) {
    const context = this.props.context();
    if (!context || (!body.trim() && annotations.length === 0)) return undefined;
    const anchor: ReviewAnchor = {
      path: selection.artifactId
        ? `session:${context.sessionId}/artifact/${selection.artifactId}`
        : `session:${context.sessionId}/message/${selection.messageId}`,
      view: selection.artifactId ? "artifact" : "message",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: selection.selectedText,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
      diff: "",
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
    };
    if (!selection.artifactId) Object.assign(anchor, { messageId: selection.messageId });
    if (selection.entryId !== undefined) Object.assign(anchor, { entryId: selection.entryId });
    return this.props.host().createThread(anchor, body, annotations.slice());
  }
}
