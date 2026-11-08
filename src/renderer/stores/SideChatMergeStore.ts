import { Store } from "r-state-tree";
import type { ReviewThread } from "../models/ReviewThread";
import type { ChatStore } from "./ChatStore";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

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
  error: string | undefined;

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
    this.error = undefined;
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
      if (!this.signal.aborted) this.error = describeError(error).message;
      return false;
    } finally {
      this.pending = false;
    }
  }
}
