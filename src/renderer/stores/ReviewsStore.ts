import { Store, observable } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionCacheStore } from "./SessionCacheStore";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import { describeError } from "../error-details";

export interface ReviewsStoreProps {
  client: Pick<DesktopClient, "createReviewThread" | "replyReviewThread" | "resolveReviewThread" | "listReviewThreads" | "submitReviewThreads">;
  sessionCache: SessionCacheStore;
  context(): { workspacePath: string; sessionId: string } | undefined;
  model(): { provider: string; id: string } | undefined;
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
    return this.props.sessionCache.find(sessionId, workspacePath)?.reviewThreads ?? [];
  }

  codeThreadsForSession(workspacePath: string, sessionId: string) {
    return this.threadsForSession(workspacePath, sessionId).filter((thread) => thread.anchor.view !== "message");
  }

  private submittedThreadIds() {
    return new Set(Object.values(this.submissionsByOperation).flat());
  }

  pendingThreadsForSession(workspacePath: string, sessionId: string) {
    const submitting = this.submittedThreadIds();
    return this.codeThreadsForSession(workspacePath, sessionId).filter((thread) => thread.pending && !submitting.has(thread.id));
  }

  chatThreadsForSession(workspacePath: string, sessionId: string) {
    const submitting = this.submittedThreadIds();
    return this.codeThreadsForSession(workspacePath, sessionId).filter((thread) => thread.actionableCommentCount > 0 && !submitting.has(thread.id));
  }

  chatCommentCountForSession(workspacePath: string, sessionId: string) {
    return this.chatThreadsForSession(workspacePath, sessionId).reduce((count, thread) => count + thread.actionableCommentCount, 0);
  }

  get codeThreads() { return this.threads.filter((thread) => thread.anchor.view !== "message"); }
  get openThreads() { return this.codeThreads.filter((thread) => thread.status === "open"); }
  get pendingThreads() {
    const context = this.props.context();
    return context ? this.pendingThreadsForSession(context.workspacePath, context.sessionId) : [];
  }
  get pendingCommentCount() {
    return this.pendingThreads.reduce((count, thread) => count + thread.messages.filter((message) => message.role === "user" && !message.delivered).length, 0);
  }
  get chatThreads() {
    const context = this.props.context();
    return context ? this.chatThreadsForSession(context.workspacePath, context.sessionId) : [];
  }
  get chatCommentCount() {
    const context = this.props.context();
    return context ? this.chatCommentCountForSession(context.workspacePath, context.sessionId) : 0;
  }
  get activeThread() { return this.threads.find((thread) => thread.id === this.activeThreadId) ?? this.openThreads[0]; }
  threadStreaming(threadId: string) { return this.streamingThreadIds.includes(threadId); }

  async createThread(anchor: ReviewAnchor, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return false;
    this.clearError();
    try {
      const thread = await this.props.client.createReviewThread({ ...context, anchor, body: body.trim() });
      if (this.signal.aborted) return false;
      this.props.sessionCache.upsertReviewThread(thread);
      return true;
    } catch (error) { this.reportError(error); return false; }
  }

  async replyThread(threadId: string, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return false;
    this.clearError();
    try {
      const thread = await this.props.client.replyReviewThread({ ...context, threadId, body: body.trim() });
      if (this.signal.aborted) return false;
      this.props.sessionCache.upsertReviewThread(thread);
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
      this.props.sessionCache.upsertReviewThread(thread);
      return true;
    } catch (error) { this.reportError(error); return false; }
  }

  async loadThreads(workspacePath: string, sessionId: string) {
    this.clearError();
    try {
      const threads = await this.props.client.listReviewThreads(workspacePath, sessionId);
      if (!this.signal.aborted) this.props.sessionCache.applyReviewThreads(workspacePath, sessionId, threads);
    } catch (error) { if (!this.signal.aborted) this.reportError(error); }
  }

  async submitPending(instruction?: string) {
    await this.submitThreads(this.pendingThreads.map((thread) => thread.id), instruction);
  }

  async submitThreads(threadIds: string[], instruction?: string) {
    const context = this.props.context();
    if (!context || threadIds.length === 0) return;
    this.clearError();
    const operationId = this.props.operations.start();
    this.submissionsByOperation[operationId] = threadIds;
    const commentCount = this.threads.filter((thread) => threadIds.includes(thread.id))
      .reduce((count, thread) => count + thread.messages.filter((message) => message.role === "user" && !message.delivered).length, 0);
    try {
      await this.props.client.submitReviewThreads({ operationId, ...context, threadIds, commentCount: Math.max(commentCount, threadIds.length), instruction, model: this.props.model() });
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
