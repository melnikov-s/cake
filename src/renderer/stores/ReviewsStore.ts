import { Store, child, createStore, observable } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { describeError } from "../error-details";
import type { ThinkingLevel } from "../../ipc/session-contract";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";

export interface ReviewsStoreProps {
  client: Pick<
    DesktopClient,
    | "createReviewThread"
    | "replyReviewThread"
    | "resolveReviewThread"
    | "listReviewThreads"
    | "submitReviewThread"
  >;
  sessionRegistry: SessionRegistryStore;
  context(): { sessionId: string } | undefined;
  model(): { provider: string; id: string } | undefined;
  thinkingLevel(): ThinkingLevel | undefined;
  configuration(): ChatConfigurationStore | undefined;
  operations: SessionOperationCoordinatorStore;
}

/** Shared review workflow projected into chat and embedded VS Code. */
export class ReviewsStore extends Store<ReviewsStoreProps> {
  streamingThreadIds: string[] = observable([]);
  submissionsByOperation: Record<string, string[]> = observable({});
  activeThreadId: string | undefined;
  draftAnchor: ReviewAnchor | undefined;
  draftFocusRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  private readonly loadRevisions = new Map<string, number>();
  private readonly resolutionRevisions = new Map<string, number>();

  constructor(props: ReviewsStore["props"]) {
    super(props);
    this.effect(() => () => {
      for (const operationId of Object.keys(this.submissionsByOperation))
        this.props.operations.finish(operationId);
    });
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  get threads() {
    const context = this.props.context();
    return context ? this.threadsForSession(context.sessionId) : [];
  }

  threadsForSession(sessionId: string) {
    return this.props.sessionRegistry.findModel(sessionId)?.reviewThreads ?? [];
  }

  codeThreadsForSession(sessionId: string) {
    return this.threadsForSession(sessionId).filter((thread) => thread.anchor.view !== "message");
  }

  private submittedThreadIds() {
    return new Set(Object.values(this.submissionsByOperation).flat());
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
    return this.props.configuration();
  }
  threadStreaming(threadId: string) {
    return this.streamingThreadIds.includes(threadId);
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

  prepareDraft(anchor: ReviewAnchor) {
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
      configuration: () => this.props.configuration(),
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
        streaming: () => this.threadStreaming(thread.id),
        submitting: () => false,
        configuration: () => this.props.configuration(),
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () =>
          thread.anchor.view === "message" ? "Reply to selection chat" : "Reply to code chat",
        canSubmit: (draft) =>
          Boolean(draft.trim()) &&
          thread.status === "open" &&
          !thread.pending &&
          !this.threadStreaming(thread.id),
        submit: async (draft) => {
          const saved = await this.replyThread(thread.id, draft);
          if (saved) await this.submitThread(thread.id, thread.sessionId);
          return saved;
        },
        composerVisible: () =>
          thread.status === "open" && !thread.pending && !this.threadStreaming(thread.id),
        error: () => ({ message: this.error, details: this.errorDetails }),
        usage: () => thread.usage,
      }),
    );
  }

  chatStore(threadId: string) {
    return this.chatStores.find((chat) => chat.id === threadId);
  }

  async createThread(anchor: ReviewAnchor, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return undefined;
    this.clearError();
    try {
      const thread = await this.props.client.createReviewThread({
        sessionId: context.sessionId,
        anchor,
        body: body.trim(),
      });
      if (this.signal.aborted) return undefined;
      this.props.sessionRegistry.upsertReviewThread(thread);
      await this.submitThread(thread.id, context.sessionId);
      return thread.id;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return undefined;
    }
  }

  async replyThread(threadId: string, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return false;
    this.clearError();
    try {
      const thread = await this.props.client.replyReviewThread({
        sessionId: context.sessionId,
        threadId,
        body: body.trim(),
      });
      if (this.signal.aborted) return false;
      this.props.sessionRegistry.upsertReviewThread(thread);
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  /** Repeated resolution changes are latest-wins per thread. */
  async resolveThread(threadId: string, resolved = true) {
    const context = this.props.context();
    if (!context) return false;
    const revision = (this.resolutionRevisions.get(threadId) ?? 0) + 1;
    this.resolutionRevisions.set(threadId, revision);
    this.clearError();
    try {
      const thread = await this.props.client.resolveReviewThread({
        sessionId: context.sessionId,
        threadId,
        resolved,
      });
      if (this.signal.aborted || this.resolutionRevisions.get(threadId) !== revision) return false;
      this.props.sessionRegistry.upsertReviewThread(thread);
      return true;
    } catch (error) {
      if (!this.signal.aborted && this.resolutionRevisions.get(threadId) === revision)
        this.reportError(error);
      return false;
    }
  }

  /** Repeated loads are latest-wins per session. */
  async loadThreads(sessionId: string) {
    const revision = (this.loadRevisions.get(sessionId) ?? 0) + 1;
    this.loadRevisions.set(sessionId, revision);
    this.clearError();
    try {
      const threads = await this.props.client.listReviewThreads(sessionId);
      if (this.signal.aborted || this.loadRevisions.get(sessionId) !== revision) return;
      this.props.sessionRegistry.applyReviewThreads(sessionId, threads);
    } catch (error) {
      if (!this.signal.aborted && this.loadRevisions.get(sessionId) === revision)
        this.reportError(error);
    }
  }

  async submitThread(threadId: string, sessionId = this.props.context()?.sessionId) {
    if (!sessionId || this.submittedThreadIds().has(threadId) || this.signal.aborted) return;
    this.clearError();
    const session = this.props.sessionRegistry.findModel(sessionId);
    const operationId = this.props.operations.start();
    this.submissionsByOperation[operationId] = [threadId];
    try {
      await this.props.client.submitReviewThread({
        operationId,
        sessionId,
        threadId,
        model: session?.model ?? this.props.model(),
        thinkingLevel: session?.thinkingLevel ?? this.props.thinkingLevel(),
      });
    } catch (error) {
      delete this.submissionsByOperation[operationId];
      this.props.operations.finish(operationId);
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "review-thread-streaming") {
      const index = this.streamingThreadIds.indexOf(event.threadId);
      if (event.streaming && index < 0) this.streamingThreadIds.push(event.threadId);
      if (!event.streaming && index >= 0) this.streamingThreadIds.splice(index, 1);
    } else if (event.type === "review-thread-part-updated") {
      this.props.sessionRegistry
        .findModel(event.sessionId)
        ?.reviewThreads.find((thread) => thread.id === event.threadId)
        ?.upsertPart(event.part);
    } else if (event.type === "review-thread-usage-updated") {
      const thread = this.props.sessionRegistry
        .findModel(event.sessionId)
        ?.reviewThreads.find((item) => item.id === event.threadId);
      thread?.setUsage(event.usage);
    } else if (event.type === "operation-completed") {
      const threadIds = this.submissionsByOperation[event.operationId];
      if (!threadIds) return;
      delete this.submissionsByOperation[event.operationId];
      this.props.operations.finish(event.operationId);
    } else if (
      event.type === "operation-failed" &&
      event.operationId &&
      this.submissionsByOperation[event.operationId]
    ) {
      delete this.submissionsByOperation[event.operationId];
      this.props.operations.finish(event.operationId);
      this.reportError(event.message);
    } else if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      for (const operationId of Object.keys(this.submissionsByOperation)) {
        delete this.submissionsByOperation[operationId];
        this.props.operations.finish(operationId);
      }
    }
  }

  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
