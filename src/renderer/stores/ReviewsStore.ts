import { Store, child, createStore } from "r-state-tree";
import type { DiscussionAnchor } from "../../domain/discussion-session-data";
import { RendererClientContext } from "../client/RendererClientContext";
import { ActiveProjectSessionContext } from "../context/ActiveProjectSessionContext";
import { describeError } from "../error-details";
import { ChatStore } from "./ChatStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

export interface ReviewsStoreProps {
  sessionRegistry: SessionRegistryStore;
}

/** Shared Discussion Session workflow projected into chat and embedded VS Code. */
export class ReviewsStore extends Store<ReviewsStoreProps> {
  activeThreadId: string | undefined;
  draftAnchor: DiscussionAnchor | undefined;
  draftFocusRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  private readonly resolutionRevisions = new Map<string, number>();

  get client() {
    return RendererClientContext.consume(this)!;
  }

  get context() {
    return ActiveProjectSessionContext.consume(this);
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  get threads() {
    const context = this.context;
    return context ? this.threadsForSession(context.sessionId) : [];
  }

  threadsForSession(sessionId: string) {
    return this.props.sessionRegistry.findModel(sessionId)?.reviewThreads ?? [];
  }

  codeThreadsForSession(sessionId: string) {
    return this.threadsForSession(sessionId).filter((thread) => thread.anchor.view !== "message");
  }

  get codeThreads() {
    return this.threads.filter((thread) => thread.anchor.view !== "message");
  }
  get openThreads() {
    return this.codeThreads.filter((thread) => thread.status === "open");
  }
  get activeThread() {
    return this.threads.find((thread) => thread.id === this.activeThreadId) ?? this.openThreads[0];
  }
  get configuration() {
    const context = this.context;
    return context
      ? this.props.sessionRegistry.findSession(context.sessionId)?.configurationStore
      : undefined;
  }
  threadStreaming(threadId: string) {
    return this.threads.find((thread) => thread.id === threadId)?.streaming ?? false;
  }

  selectThread(threadId: string) {
    this.activeThreadId = threadId;
  }

  trySelectThread(threadId: string) {
    if (!this.threads.some((thread) => thread.id === threadId)) return false;
    this.selectThread(threadId);
    return true;
  }

  clearActiveThread() {
    this.activeThreadId = undefined;
  }

  prepareDraft(anchor: DiscussionAnchor) {
    this.draftChatStore.setDraft("");
    this.draftAnchor = anchor;
    this.draftFocusRequestRevision += 1;
  }

  cancelDraft() {
    this.draftAnchor = undefined;
    this.draftChatStore.setDraft("");
  }

  @child
  get draftChatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => "code-review-draft",
      parts: () =>
        this.draftAnchor
          ? [
              {
                id: `code-review-draft:${this.draftFocusRequestRevision}`,
                kind: "text" as const,
                role: "user" as const,
                text: this.draftAnchor.selectedText,
                status: "complete" as const,
              },
            ]
          : [],
      streaming: () => false,
      submitting: () => false,
      configuration: () => this.configuration,
      commands: () => [],
      placeholder: () => "Ask Cake about this code…",
      inputLabel: () => "Message code chat",
      focusRequestRevision: () => this.draftFocusRequestRevision,
      canSubmit: (draft) => Boolean(this.draftAnchor && draft.trim()),
      submit: async (draft) => {
        const anchor = this.draftAnchor;
        if (!anchor) return false;
        const threadId = await this.createThread(anchor, draft);
        if (threadId && this.draftAnchor === anchor) {
          this.cancelDraft();
          this.selectThread(threadId);
        }
        return Boolean(threadId);
      },
      error: () => ({ message: this.error, details: this.errorDetails }),
    });
  }

  @child
  get chatStores(): ChatStore[] {
    return this.threads.map((thread) =>
      createStore(ChatStore, {
        key: thread.id,
        id: () => thread.id,
        parts: () => [
          {
            id: `anchor:${thread.id}`,
            kind: "text" as const,
            role: "user" as const,
            text: thread.anchor.selectedText,
            status: "complete" as const,
          },
          ...thread.uiParts,
        ],
        streaming: () => thread.streaming,
        submitting: () => false,
        configuration: () => this.configuration,
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () =>
          thread.anchor.view === "message" ? "Reply to selection chat" : "Reply to code chat",
        canSubmit: (draft) =>
          Boolean(draft.trim()) && thread.status === "open" && !thread.streaming,
        submit: (draft) => this.replyThread(thread.id, draft),
        composerVisible: () => thread.status === "open" && !thread.streaming,
        error: () => ({ message: this.error, details: this.errorDetails }),
        usage: () => thread.usage,
      }),
    );
  }

  chatStore(threadId: string) {
    return this.chatStores.find((chat) => chat.id === threadId);
  }

  async createThread(anchor: DiscussionAnchor, body: string) {
    const context = this.context;
    if (!context || !body.trim()) return undefined;
    this.clearError();
    try {
      const thread = await this.client.discussionSessions.create(
        {
          parentSessionId: context.sessionId,
          workingDirectory: context.workingDirectory,
          anchor,
        },
        { signal: this.signal },
      );
      if (this.signal.aborted) return undefined;
      await this.promptThread(thread.id, body.trim());
      return thread.id;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return undefined;
    }
  }

  async replyThread(threadId: string, body: string) {
    if (!body.trim()) return false;
    try {
      await this.promptThread(threadId, body.trim());
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  async resolveThread(threadId: string, resolved = true) {
    const context = this.context;
    if (!context) return false;
    const revision = (this.resolutionRevisions.get(threadId) ?? 0) + 1;
    this.resolutionRevisions.set(threadId, revision);
    this.clearError();
    try {
      await this.client.discussionSessions.setResolved(
        {
          parentSessionId: context.sessionId,
          workingDirectory: context.workingDirectory,
          threadId,
          resolved,
        },
        { signal: this.signal },
      );
      return !this.signal.aborted && this.resolutionRevisions.get(threadId) === revision;
    } catch (error) {
      if (!this.signal.aborted && this.resolutionRevisions.get(threadId) === revision)
        this.reportError(error);
      return false;
    }
  }

  private async promptThread(threadId: string, text: string) {
    const context = this.context;
    if (!context) throw new Error("There is no active Project Session");
    const session = this.props.sessionRegistry.findModel(context.sessionId);
    await this.client.discussionSessions.prompt(
      {
        parentSessionId: context.sessionId,
        workingDirectory: context.workingDirectory,
        threadId,
        text,
        model: session?.model,
        thinkingLevel: session?.thinkingLevel,
      },
      { signal: this.signal },
    );
  }

  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
