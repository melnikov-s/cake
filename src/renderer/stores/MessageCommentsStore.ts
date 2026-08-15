import { Store } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { DesktopClient } from "../desktop-client";
import type { SessionCacheStore } from "./SessionCacheStore";
import type { ReviewsStore } from "./ReviewsStore";
import { describeError } from "../error-details";

export interface MessageCommentsStoreProps {
  client: Pick<DesktopClient, "createReviewThread" | "replyReviewThread">;
  sessionCache: SessionCacheStore;
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

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }
  get threads() {
    const context = this.props.context();
    if (!context) return [];
    return this.props.sessionCache.find(context.sessionId, context.workspacePath)?.reviewThreads
      .filter((thread) => thread.anchor.view === "message") ?? [];
  }

  threadsForMessage(messageId: string) {
    return this.threads.filter((thread) => thread.anchor.messageId === messageId);
  }

  threadStreaming(threadId: string) {
    return this.props.reviews().threadStreaming(threadId);
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
      this.props.sessionCache.upsertReviewThread(thread);
      await this.props.reviews().submitThreads([thread.id]);
      return thread.id;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return undefined;
    }
  }

  async replyThread(threadId: string, body: string) {
    const context = this.props.context();
    if (!context || !body.trim()) return false;
    try {
      const thread = await this.props.client.replyReviewThread({ ...context, threadId, body: body.trim() });
      if (this.signal.aborted) return false;
      this.props.sessionCache.upsertReviewThread(thread);
      await this.props.reviews().submitThreads([thread.id]);
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  resolveThread(threadId: string, resolved = true) {
    return this.props.reviews().resolveThread(threadId, resolved);
  }
}
