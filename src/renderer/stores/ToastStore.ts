import { Store, observable } from "r-state-tree";

export interface Toast {
  id: string;
  tone: "info" | "warning" | "error";
  title: string;
  message: string;
  action?: { label: string; run(): void | Promise<void> };
  coalesceKey?: string;
}

export interface ToastInput {
  tone?: Toast["tone"];
  title: string;
  message: string;
  action?: Toast["action"];
  coalesceKey?: string;
}

const MAX_TOASTS = 4;
const TOAST_TIMEOUT_MS = 8_000;

/** Owns transient app-level toast notifications shown in the window corner. */
export class ToastStore extends Store {
  toasts: Toast[] = observable([]);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(props: Record<string, never>) {
    super(props);
    this.effect(() => () => {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    });
  }

  show(toast: ToastInput) {
    const existing = toast.coalesceKey
      ? this.toasts.find((item) => item.coalesceKey === toast.coalesceKey)
      : undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const next: Toast = {
      id,
      tone: toast.tone ?? "info",
      title: toast.title,
      message: toast.message,
    };
    if (toast.action) next.action = toast.action;
    if (toast.coalesceKey) next.coalesceKey = toast.coalesceKey;
    if (existing) this.toasts.splice(this.toasts.indexOf(existing), 1, next);
    else this.toasts.push(next);
    if (this.toasts.length > MAX_TOASTS) this.dismiss(this.toasts[0]!.id);
    const previousTimer = this.timers.get(id);
    if (previousTimer) clearTimeout(previousTimer);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.dismiss(id);
      }, TOAST_TIMEOUT_MS),
    );
  }

  runAction(id: string) {
    const action = this.toasts.find((toast) => toast.id === id)?.action;
    this.dismiss(id);
    if (action) void action.run();
  }

  dismiss(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const index = this.toasts.findIndex((item) => item.id === id);
    if (index >= 0) this.toasts.splice(index, 1);
  }
}
