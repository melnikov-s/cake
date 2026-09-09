import { Store, observable } from "r-state-tree";
import type { Attachment } from "../../ipc/session-contract";

/** A prompt held locally while the session streams, shown above the composer. */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Attachment[];
  renderUserMessageAsMarkdown: boolean;
}

export interface PromptQueueStoreProps {
  isStreaming(): boolean;
  deliver(entry: QueuedPrompt, delivery: "prompt" | "steer"): Promise<boolean>;
  restoreForEditing(entry: QueuedPrompt): void;
  clearRemoteQueue?(): Promise<void>;
  clearOptimisticSteering?(): void;
}

/** Owns editable local follow-up prompts and their ordered drain policy. */
export class PromptQueueStore extends Store<PromptQueueStoreProps> {
  readonly prompts: QueuedPrompt[] = observable([]);
  private draining = false;

  constructor(props: PromptQueueStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.isStreaming(),
      (streaming, previousStreaming) => {
        if (previousStreaming && !streaming) this.drain();
      },
    );
  }

  enqueue(text: string, attachments: Attachment[], renderUserMessageAsMarkdown: boolean) {
    this.prompts.push({
      id: crypto.randomUUID(),
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      renderUserMessageAsMarkdown,
    });
  }

  remove(id: string) {
    this.take(id);
  }

  edit(id: string) {
    const entry = this.take(id);
    if (!entry) return undefined;
    this.props.restoreForEditing(entry);
    return entry.renderUserMessageAsMarkdown;
  }

  steer(id: string) {
    const entry = this.take(id);
    if (!entry) return;
    void this.deliverAndRestore(entry, this.props.isStreaming() ? "steer" : "prompt");
  }

  async cancelSteering() {
    if (!this.props.clearRemoteQueue) return;
    await this.props.clearRemoteQueue();
    if (!this.signal.aborted) this.props.clearOptimisticSteering?.();
  }

  private take(id: string) {
    const index = this.prompts.findIndex((entry) => entry.id === id);
    return index >= 0 ? this.prompts.splice(index, 1)[0] : undefined;
  }

  private drain() {
    if (this.draining || this.props.isStreaming()) return;
    const entry = this.prompts.shift();
    if (!entry) return;
    this.draining = true;
    void this.deliverAndRestore(entry, "prompt").finally(() => {
      if (!this.signal.aborted) this.draining = false;
    });
  }

  private async deliverAndRestore(entry: QueuedPrompt, delivery: "prompt" | "steer") {
    const delivered = await this.props.deliver(entry, delivery);
    if (!delivered && !this.signal.aborted) this.prompts.unshift(entry);
    return delivered;
  }
}
