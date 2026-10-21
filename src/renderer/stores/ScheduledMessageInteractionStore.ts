import { Store, untracked } from "r-state-tree";
import type { ScheduledMessage } from "../models/ScheduledMessage";

export interface ScheduledMessageCapabilities {
  messages(): readonly ScheduledMessage[];
  cancel?(id: string): Promise<void>;
}

/** Owns scheduled-message countdown presentation, disclosure, cancellation state, and its timer
 * resource. Scheduled items sit below steering and queued items in the pending list. */
export class ScheduledMessageInteractionStore extends Store<{
  capabilities?: ScheduledMessageCapabilities;
}> {
  error: string | undefined;
  /** The user's explicit disclosure choice; undefined follows the default. */
  private expandedChoice: boolean | undefined;
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

  /** Pending schedules in send order. */
  get messages(): readonly ScheduledMessage[] {
    return (this.props.capabilities?.messages() ?? []).toSorted((left, right) =>
      left.sendAt.localeCompare(right.sendAt),
    );
  }

  get repeatingCount() {
    return this.messages.filter((message) => message.repeatEverySeconds !== undefined).length;
  }

  /** Expanded by default only when no steering or queued items compete for the space. */
  isExpanded(othersPending: boolean) {
    return this.expandedChoice ?? !othersPending;
  }

  toggleExpanded(othersPending: boolean) {
    this.expandedChoice = !this.isExpanded(othersPending);
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
