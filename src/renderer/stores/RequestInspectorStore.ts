import { batch, Store } from "r-state-tree";
import type { RequestInspectionPayload } from "../../contracts/conversations/request-inspection";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Backend owns immutable captures. This session-owned, window-local reader is never persisted.
 * Poll only while open, serialize reads, and fetch bodies only when the newest capture changes.
 * Close/disposal aborts reads and timers; late results cannot replace a reopened view. No LLM calls. */
export class RequestInspectorStore extends Store<{ sessionId: string }> {
  open = false;
  loading = false;
  error: string | undefined;
  copyError: string | undefined;
  payload: RequestInspectionPayload | undefined;
  copied = false;
  private revision = 0;
  private requestController: AbortController | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: RequestInspectorStore["props"]) {
    super(props);
    this.effect(() => () => this.close());
  }

  show() {
    if (this.open || this.signal.aborted) return;
    this.open = true;
    void this.readLatest();
  }

  close() {
    this.revision += 1;
    this.requestController?.abort();
    this.requestController = undefined;
    clearTimeout(this.pollTimer);
    clearTimeout(this.copyTimer);
    this.pollTimer = undefined;
    this.copyTimer = undefined;
    batch(() => {
      this.open = false;
      this.loading = false;
      this.payload = undefined;
      this.error = undefined;
      this.copyError = undefined;
      this.copied = false;
    });
  }

  private current(revision: number, signal: AbortSignal) {
    return revision === this.revision && !signal.aborted && this.open;
  }

  private async readLatest() {
    const revision = ++this.revision;
    const controller = new AbortController();
    this.requestController = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    if (!this.payload) this.loading = true;
    try {
      const client = ClientContext.consume(this)!;
      const { history } = await client.cakeChats.requestInspection(
        { sessionId: this.props.sessionId, action: "history" },
        { signal },
      );
      if (!this.current(revision, signal)) return;
      const latest = history.entries.at(-1);
      if (!latest) {
        this.payload = undefined;
      } else if (latest.id !== this.payload?.entry.id) {
        batch(() => {
          this.payload = undefined;
          this.loading = true;
          this.copied = false;
          this.copyError = undefined;
        });
        clearTimeout(this.copyTimer);
        const result = await client.cakeChats.requestInspection(
          { sessionId: this.props.sessionId, action: "payload", id: latest.id },
          { signal },
        );
        if (!this.current(revision, signal)) return;
        this.payload = result.payload;
      } else if (
        this.payload &&
        (this.payload.entry.state !== latest.state ||
          this.payload.entry.status !== latest.status ||
          this.payload.entry.limitation !== latest.limitation)
      ) {
        this.payload = { ...this.payload, entry: latest };
      }
      this.error = undefined;
    } catch (error) {
      if (this.current(revision, signal)) this.error = describeError(error).message;
    } finally {
      if (this.current(revision, signal)) {
        this.loading = false;
        this.requestController = undefined;
        this.pollTimer = setTimeout(() => void this.readLatest(), 1000);
      }
    }
  }

  async copy() {
    const payload = this.payload;
    if (payload?.raw === undefined) return;
    this.copyError = undefined;
    try {
      await navigator.clipboard.writeText(payload.raw);
      if (!this.open || this.signal.aborted || this.payload?.entry.id !== payload.entry.id) return;
      this.copied = true;
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copied = false;
      }, 1500);
    } catch (error) {
      if (this.open && !this.signal.aborted && this.payload?.entry.id === payload.entry.id)
        this.copyError = describeError(error).message;
    }
  }
}
