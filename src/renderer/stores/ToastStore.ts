import { Store, observable } from "r-state-tree";
import { TOAST_TIMEOUT_MS, ToastExpiry } from "./toast-expiry";

export interface Toast {
  id: string;
  tone: "info" | "warning" | "error";
  title: string;
  message: string;
  details?: string;
  action?: { label: string; run(): void | Promise<void> };
  coalesceKey?: string;
}

export interface ToastInput {
  tone?: Toast["tone"];
  title: string;
  message: string;
  details?: string;
  action?: Toast["action"];
  coalesceKey?: string;
}

const MAX_TOASTS = 4;
const ACTIONABLE_TOAST_TIMEOUT_MS = 20_000;

/** Owns transient app-level toast notifications shown in the window corner. */
export class ToastStore extends Store {
  toasts: Toast[] = observable([]);
  private readonly expiry = new ToastExpiry();

  constructor(props: Record<string, never>) {
    super(props);
    this.effect(() => () => this.expiry.clear());
  }

  show(toast: ToastInput) {
    if (this.signal.aborted) return;
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
    if (toast.details) next.details = toast.details;
    if (toast.action) next.action = toast.action;
    if (toast.coalesceKey) next.coalesceKey = toast.coalesceKey;
    if (existing) this.toasts.splice(this.toasts.indexOf(existing), 1, next);
    else this.toasts.push(next);
    if (this.toasts.length > MAX_TOASTS) this.dismiss(this.toasts[0]!.id);
    this.expiry.start(
      id,
      next.action || next.details ? ACTIONABLE_TOAST_TIMEOUT_MS : TOAST_TIMEOUT_MS,
      () => this.dismiss(id),
    );
  }

  setToastPaused(id: string, paused: boolean) {
    this.expiry.setPaused(id, paused);
  }

  runAction(id: string) {
    const action = this.toasts.find((toast) => toast.id === id)?.action;
    this.dismiss(id);
    if (action) void action.run();
  }

  dismiss(id: string) {
    this.expiry.remove(id);
    const index = this.toasts.findIndex((item) => item.id === id);
    if (index >= 0) this.toasts.splice(index, 1);
  }
}
