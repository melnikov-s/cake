import { Store } from "r-state-tree";
import { ClientContext } from "./context/ClientContext";
import { ToastContext } from "./context/ToastContext";

interface AgentNotificationInput {
  readonly title: string;
  readonly body: string;
  readonly level: "info" | "success" | "warning" | "error";
  readonly source?: {
    readonly sessionId: string;
    readonly title: string;
  };
}

interface PendingNotification {
  input: AgentNotificationInput;
  timer: ReturnType<typeof setTimeout>;
}

const NOTIFICATION_DEBOUNCE_MS = 3_000;
const UNATTRIBUTED_KEY = "cake-agent";

/** Owns batching and delivery policy for agent-requested notifications. */
export class NotificationStore extends Store {
  private get toast() {
    return ToastContext.consume(this)!;
  }
  private readonly pending = new Map<string, PendingNotification>();

  constructor(props: NotificationStore["props"]) {
    super(props);
    this.effect(() => () => {
      for (const notification of this.pending.values()) clearTimeout(notification.timer);
      this.pending.clear();
    });
  }

  enqueue(input: AgentNotificationInput): Promise<void> {
    const key = input.source?.sessionId ?? UNATTRIBUTED_KEY;
    const previous = this.pending.get(key);
    if (previous) clearTimeout(previous.timer);
    this.pending.set(key, {
      input,
      timer: setTimeout(() => this.flush(key), NOTIFICATION_DEBOUNCE_MS),
    });
    return Promise.resolve();
  }

  private flush(key: string) {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    const nativeId = `cake-agent:${key}`;
    const title = pending.input.source
      ? `${pending.input.title} · ${pending.input.source.title}`
      : pending.input.title;
    this.toast.show({
      title,
      message: pending.input.body,
      tone: pending.input.level === "success" ? "info" : pending.input.level,
      coalesceKey: nativeId,
    });
    void ClientContext.consume(this)!
      .electron.showNotification(
        {
          title,
          body: pending.input.body,
          level: pending.input.level,
          id: nativeId,
          groupId: nativeId,
        },
        { signal: this.signal },
      )
      .catch((error: unknown) => {
        if (!this.signal.aborted)
          this.toast.show({
            tone: "error",
            title: "Notification failed",
            message: error instanceof Error ? error.message : String(error),
          });
      });
  }
}
