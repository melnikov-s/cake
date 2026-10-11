import { batch, Store } from "r-state-tree";
import type {
  RequestInspectionHistory,
  RequestInspectionPayload,
} from "../../contracts/conversations/request-inspection";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Window-local diagnostics UI. Backend owns captured bodies; never persisted in window
 * snapshots. Latest user intent wins; close/disposal invalidates late reads. No LLM calls. */
export class RequestInspectorStore extends Store<{ sessionId: string }> {
  open = false;
  loading = false;
  error: string | undefined;
  history: RequestInspectionHistory | undefined;
  payload: RequestInspectionPayload | undefined;
  query = "";
  notice: string | undefined;
  private revision = 0;

  show() {
    this.open = true;
    void this.refresh();
  }
  close() {
    this.revision += 1;
    batch(() => {
      this.open = false;
      this.loading = false;
      this.payload = undefined;
      this.history = undefined;
      this.query = "";
      this.error = undefined;
      this.notice = undefined;
    });
  }
  setQuery(query: string) {
    this.query = query;
  }
  private async request(action: "history" | "payload" | "clear", id?: string) {
    const revision = ++this.revision;
    this.loading = true;
    this.error = undefined;
    this.notice = undefined;
    this.payload = undefined;
    try {
      const client = ClientContext.consume(this)!;
      const result = await client.cakeChats.requestInspection(
        id === undefined
          ? { sessionId: this.props.sessionId, action }
          : { sessionId: this.props.sessionId, action, id },
        { signal: this.signal },
      );
      if (revision !== this.revision || this.signal.aborted || !this.open) return;
      this.history = result.history;
      this.payload = result.payload;
      if (action === "history") {
        const latest = result.history.entries.at(-1);
        if (latest) await this.select(latest.id);
      }
    } catch (error) {
      if (revision === this.revision && !this.signal.aborted)
        this.error = describeError(error).message;
    } finally {
      if (revision === this.revision && !this.signal.aborted) this.loading = false;
    }
  }
  refresh() {
    return this.request("history");
  }
  select(id: string) {
    this.query = "";
    return this.request("payload", id);
  }
  clear() {
    return this.request("clear");
  }
  async copy() {
    const raw = this.payload?.raw;
    if (raw === undefined) return;
    try {
      await navigator.clipboard.writeText(raw);
      this.notice = "Raw payload copied";
    } catch (error) {
      this.error = describeError(error).message;
    }
  }
  export() {
    const payload = this.payload;
    if (payload?.raw === undefined) return;
    const url = URL.createObjectURL(new Blob([payload.raw], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `cake-chat-${payload.entry.boundary}-${payload.entry.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
