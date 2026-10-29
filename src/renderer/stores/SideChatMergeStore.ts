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

/** Explicit historical import; never sends a prompt or closes the source chat. */
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

  get disabled() {
    const side = this.props.sideChat();
    return this.pending || this.props.parentBusy() || side.loading || side.queuedPrompts.length > 0;
  }

  get label() {
    return this.pending
      ? "Merging…"
      : this.alreadyMerged
        ? "Already merged"
        : "Merge into main chat";
  }

  async run() {
    if (this.disabled) return;
    this.pending = true;
    this.error = undefined;
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
      if (!this.signal.aborted)
        this.alreadyMergedThrough = result.importedMessages === 0 ? this.sourceTail : undefined;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      this.pending = false;
    }
  }
}
