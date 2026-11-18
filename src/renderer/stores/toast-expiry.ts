import { observable } from "r-state-tree";

export const TOAST_TIMEOUT_MS = 8_000;

type Expiry = {
  readonly timeoutMs: number;
  readonly dismiss: () => void;
  // An entry without a timer is paused.
  readonly timer: ReturnType<typeof setTimeout> | undefined;
};

/** Timer bookkeeping shared by the two stores that supply the corner stack. */
export class ToastExpiry {
  private readonly entries = observable(new Map<string, Expiry>());

  start(id: string, timeoutMs: number, dismiss: () => void) {
    const previous = this.entries.get(id);
    this.remove(id);
    this.entries.set(id, {
      timeoutMs,
      dismiss,
      timer: previous && previous.timer === undefined ? undefined : setTimeout(dismiss, timeoutMs),
    });
  }

  setPaused(id: string, paused: boolean) {
    const entry = this.entries.get(id);
    if (!entry || paused === (entry.timer === undefined)) return;
    clearTimeout(entry.timer);
    // Give the toast a fresh reading interval after the interaction ends.
    this.entries.set(id, {
      ...entry,
      timer: paused ? undefined : setTimeout(entry.dismiss, entry.timeoutMs),
    });
  }

  remove(id: string) {
    clearTimeout(this.entries.get(id)?.timer);
    this.entries.delete(id);
  }

  clear() {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}
