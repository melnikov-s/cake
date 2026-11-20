import { Store } from "r-state-tree";
import type { ReviewThread } from "../models/ReviewThread";
import type { ChatStore } from "./ChatStore";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";
import { ToastContext } from "./context/ToastContext";

interface SideChatMergeStoreProps {
  thread: ReviewThread;
  parentBusy(): boolean;
  sideChat(): ChatStore;
}

/** Explicit dialogue import; the backend resolves the source only after success. */
export class SideChatMergeStore extends Store<SideChatMergeStoreProps> {
  pending = false;
  private alreadyMergedThrough: string | undefined;

  get alreadyMerged() {
    return this.alreadyMergedThrough === this.sourceTail;
  }

  private get sourceTail() {
    return this.props.sideChat().parts.at(-1)?.id ?? "";
  }

  private get busy() {
    const side = this.props.sideChat();
    return this.props.parentBusy() || side.loading || side.queuedPrompts.length > 0;
  }

  get label() {
    return this.pending
      ? this.busy
        ? "Merge queued…"
        : "Merging…"
      : this.alreadyMerged
        ? "Already merged"
        : "Merge into main chat";
  }

  async run() {
    if (this.pending || this.signal.aborted) return false;
    this.pending = true;
    const sourceTail = this.sourceTail;
    try {
      const thread = this.props.thread;
      const result = await ClientContext.consume(this)!.discussionSessions.merge(
        {
          parentSessionId: thread.parentSessionId,
          workingDirectory: thread.workingDirectory,
          threadId: thread.id,
        },
        { signal: this.signal },
      );
      if (this.signal.aborted) return false;
      this.alreadyMergedThrough = result.importedMessages === 0 ? sourceTail : undefined;
      return true;
    } catch (error) {
      // A one-off action failure: the side chat stays open for a retry.
      if (!this.signal.aborted)
        ToastContext.consume(this)?.show({
          tone: "error",
          title: "Could not merge side chat",
          message: describeError(error).message,
          coalesceKey: `side-chat-merge:${this.props.thread.id}`,
        });
      return false;
    } finally {
      this.pending = false;
    }
  }
}
