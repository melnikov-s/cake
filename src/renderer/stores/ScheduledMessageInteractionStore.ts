import { Store, untracked } from "r-state-tree";
import type { ScheduledMessage } from "../models/ScheduledMessage";

export interface ScheduledMessageCapabilities {
  messages(): readonly ScheduledMessage[];
  cancel?(id: string): Promise<void>;
}

/** Owns scheduled-message countdown presentation, cancellation state, and its timer resource. */
export class ScheduledMessageInteractionStore extends Store<{
  capabilities?: ScheduledMessageCapabilities;
}> {
  error: string | undefined;
  private now = Date.now();
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  constructor(props: ScheduledMessageInteractionStore["props"]) {
    super(props);
    untracked(() => this.updateTick((this.props.capabilities?.messages().length ?? 0) > 0));
    this.reaction(
      () => (this.props.capabilities?.messages().length ?? 0) > 0,
      (active) => this.updateTick(active),
    );
    this.effect(() => () => this.stopTick());
  }

  get messages(): readonly ScheduledMessage[] {
    return this.props.capabilities?.messages() ?? [];
  }

  get canCancel() {
    return Boolean(this.props.capabilities?.cancel);
  }

  remainingMs(sendAt: string) {
    return Math.max(0, Date.parse(sendAt) - this.now);
  }

  async cancel(id: string) {
    const cancel = this.props.capabilities?.cancel;
    if (!cancel) return;
    this.error = undefined;
    try {
      await cancel(id);
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private updateTick(active: boolean) {
    if (!active) {
      this.stopTick();
      return;
    }
    if (this.tickInterval !== undefined) return;
    this.now = Date.now();
    this.tickInterval = setInterval(() => {
      this.now = Date.now();
    }, 1_000);
  }

  private stopTick() {
    if (this.tickInterval === undefined) return;
    clearInterval(this.tickInterval);
    this.tickInterval = undefined;
  }
}
