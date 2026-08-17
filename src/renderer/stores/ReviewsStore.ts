import { Store, child, createStore, observable } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import { describeError } from "../error-details";
import type { ThinkingLevel } from "../../ipc/session-contract";
import type { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";

export interface ReviewsStoreProps {
  client: Pick<DesktopClient, "createReviewThread" | "replyReviewThread" | "resolveReviewThread" | "listReviewThreads" | "submitReviewThread">;
  sessionRegistry: SessionRegistryStore;
  context(): { workspacePath: string; sessionId: string } | undefined;
  model(): { provider: string; id: string } | undefined;
  thinkingLevel(): ThinkingLevel | undefined;
  configuration(): ChatConfigurationStore | undefined;
  operations: SessionOperationCoordinator;
}

/** Shared review workflow used by chat, Changes, and Browse. */
export class ReviewsStore extends Store<ReviewsStoreProps> {
  streamingThreadIds: string[] = observable([]);
  submissionsByOperation: Record<string, string[]> = observable({});
  activeThreadId: string | undefined;
  error: string | undefined;
  errorDetails: string | undefined;

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  get threads() {
    const context = this.props.context();
    return context ? this.threadsForSession(context.workspacePath, context.sessionId) : [];
  }

  threadsForSession(workspacePath: string, sessionId: string) {
    return this.props.sessionRegistry.findModel(sessionId, workspacePath)?.reviewThreads ?? [];
  }

  codeThreadsForSession(workspacePath: string, sessionId: string) {
    return this.threadsForSession(workspacePath, sessionId).filter((thread) => thread.anchor.view !== "message");
  }

  private submittedThreadIds() {
    return new Set(Object.values(this.submissionsByOperation).flat());
  }

  get codeThreads() { return this.threads.filter((thread) => thread.anchor.view !== "message"); }
  get openThreads() { return this.codeThreads.filter((thread) => thread.status === "open"); }
  get activeThread() { return this.threads.find((thread) => thread.id === this.activeThreadId) ?? this.openThreads[0]; }
  get configuration() { return this.props.configuration(); }
  threadStreaming(threadId: string) { return this.streamingThreadIds.includes(threadId); }

  @child
  get chatStores(): ChatStore[] {
    return this.threads.map((thread) => createStore(ChatStore, {
      key: thread.id,
      id: () => thread.id,
      parts: () => [
        { id: `anchor:${thread.id}`, kind: "text" as const, role: "user" as const, text: thread.anchor.selectedText, status: "complete" as const },
        ...thread.uiParts
      ],
      streaming: () => this.threadStreaming(thread.id),
      submitting: () => false,
      configuration: () => this.props.configuration(),
      commands: () => [],
      placeholder: () => "Ask a follow-up…",
      inputLabel: () => thread.anchor.view === "message" ? "Reply to selection chat" : "Reply to code chat",
      canSubmit: (draft) => Boolean(draft.trim()) && thread.status === "open" && !thread.pending && !this.threadStreaming(thread.id),
      submit: async (draft) => {
        const saved = await this.replyThread(thread.id, draft);
        if (saved) await this.submitThread(thread.id);
        return saved;
      },
      composerVisible: () => thread.status === "open" && !thread.pending && !this.threadStreaming(thread.id),
      error: () => ({ message: this.error, details: this.errorDetails }),
      usage: () => thread.usage
    }));
  }

  chatStore(threadId: string) { return this.chatStores.find((chat) => chat.id === threadId); }

  async createThread(anchor: ReviewAnchor, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return undefined;
    this.clearError();
    try {
      const thread = await this.props.client.createReviewThread({ ...context, anchor, body: body.trim() });
      if (this.signal.aborted) return undefined;
      this.props.sessionRegistry.upsertReviewThread(thread);
      await this.submitThread(thread.id);
      return thread.id;
    } catch (error) { this.reportError(error); return undefined; }
  }

  async replyThread(threadId: string, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return false;
    this.clearError();
    try {
      const thread = await this.props.client.replyReviewThread({ ...context, threadId, body: body.trim() });
      if (this.signal.aborted) return false;
      this.props.sessionRegistry.upsertReviewThread(thread);
      return true;
    } catch (error) { this.reportError(error); return false; }
  }

  async resolveThread(threadId: string, resolved = true) {
    const context = this.props.context();
    if (!context) return false;
    this.clearError();
    try {
      const thread = await this.props.client.resolveReviewThread({ ...context, threadId, resolved });
      if (this.signal.aborted) return false;
      this.props.sessionRegistry.upsertReviewThread(thread);
      return true;
    } catch (error) { this.reportError(error); return false; }
  }

  async loadThreads(workspacePath: string, sessionId: string) {
    this.clearError();
    try {
      const threads = await this.props.client.listReviewThreads(workspacePath, sessionId);
      if (!this.signal.aborted) this.props.sessionRegistry.applyReviewThreads(workspacePath, sessionId, threads);
    } catch (error) { if (!this.signal.aborted) this.reportError(error); }
  }

  async submitThread(threadId: string) {
    const context = this.props.context();
    if (!context || this.submittedThreadIds().has(threadId)) return;
    this.clearError();
    const operationId = this.props.operations.start();
    this.submissionsByOperation[operationId] = [threadId];
    try {
      await this.props.client.submitReviewThread({ operationId, ...context, threadId, model: this.props.model(), thinkingLevel: this.props.thinkingLevel() });
    } catch (error) {
      delete this.submissionsByOperation[operationId];
      this.reportError(error);
      this.props.operations.finish(operationId);
    }
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "review-thread-streaming") {
      const index = this.streamingThreadIds.indexOf(event.threadId);
      if (event.streaming && index < 0) this.streamingThreadIds.push(event.threadId);
      if (!event.streaming && index >= 0) this.streamingThreadIds.splice(index, 1);
    } else if (event.type === "review-thread-part-updated") {
      this.props.sessionRegistry.findModel(event.sessionId, event.workspacePath)?.reviewThreads.find((thread) => thread.id === event.threadId)?.upsertPart(event.part);
    } else if (event.type === "review-thread-usage-updated") {
      const thread = this.props.sessionRegistry.findModel(event.sessionId, event.workspacePath)?.reviewThreads.find((item) => item.id === event.threadId);
      if (thread) thread.usage = event.usage;
    } else if (event.type === "operation-completed") {
      const threadIds = this.submissionsByOperation[event.operationId];
      if (!threadIds) return;
      delete this.submissionsByOperation[event.operationId];
      this.props.operations.finish(event.operationId);
    } else if (event.type === "operation-failed" && event.operationId && this.submissionsByOperation[event.operationId]) {
      delete this.submissionsByOperation[event.operationId];
      this.props.operations.finish(event.operationId);
      this.reportError(event.message);
    } else if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
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
