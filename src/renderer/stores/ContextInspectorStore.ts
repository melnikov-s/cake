import { batch, Store } from "r-state-tree";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import {
  decodeContextInspection,
  type ContextInspectionNode,
} from "../../contracts/conversations/context-inspection";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";
import { estimateContextTokens } from "../lib/context-token-estimate";
import {
  cakeChatCacheFreshness,
  cakeChatSummaryReason,
  type CakeChatContextStatus,
} from "../../contracts/cake-chats/context-policy";

/** Window-local context reader and explicit permanent-chat memory action. Browsing is read-only. */
export class ContextInspectorStore extends Store<{
  sessionId: string;
  isPending(): boolean;
  isBusy(): boolean;
  status?(): CakeChatContextStatus | undefined;
}> {
  private now = Date.now();

  constructor(props: ContextInspectorStore["props"]) {
    super(props);
    this.effect(() => {
      if (!this.props.status?.()?.cache) return;
      this.now = Date.now();
      const timer = setInterval(() => {
        this.now = Date.now();
      }, 1_000);
      return () => clearInterval(timer);
    });
    this.effect(() => () => this.close());
  }

  get status() {
    return this.props.status?.();
  }
  get cache() {
    return cakeChatCacheFreshness(this.status?.cache, this.now);
  }
  get cacheExpiry() {
    const cache = this.cache;
    if (cache.expiresAt === undefined) return cache.state === "uncertain" ? "Uncertain" : "Unknown";
    if (cache.expiresAt <= this.now) return "Expired";
    return `≈${Math.ceil((cache.expiresAt - this.now) / 60_000)} min`;
  }
  get usageTooltip() {
    const cache = {
      "likely-warm": "Likely warm",
      "likely-cold": "Likely cold",
      uncertain: "Uncertain",
      unknown: "Unknown",
    }[this.cache.state];
    const next = !this.status
      ? "Unknown"
      : this.status.activity === "summarizing"
        ? "Summarizing"
        : this.status.activity === "consolidating"
          ? "Consolidating"
          : this.summaryReason === "limit"
            ? "Summarize (limit)"
            : this.summaryReason
              ? "Summarize"
              : this.status.totalTokens === 0
                ? "Start"
                : "Continue";
    return `Cache: ${cache}\nExpires: ${this.cacheExpiry}\nNext: ${next}`;
  }
  get nextSend() {
    const status = this.status;
    if (!status) return "Next message: context status unavailable";
    if (status.totalTokens === 0) return "Next message starts the conversation";
    if (status.activity) return "Preparing the next model context";
    const reason = this.summaryReason;
    return reason === "limit"
      ? "Next message summarizes · context limit reached"
      : reason
        ? "Next message summarizes · cache expired or uncertain"
        : "Next message continues the current context";
  }
  get summaryReason() {
    return this.status ? cakeChatSummaryReason(this.status, this.now) : undefined;
  }
  get activityLabel() {
    return this.status?.activity === "summarizing"
      ? "Summarizing memory…"
      : this.status?.activity === "consolidating"
        ? "Consolidating memory…"
        : undefined;
  }
  get supportsCompaction() {
    return isCakeChatSessionId(this.props.sessionId);
  }
  get canCompact() {
    return (
      this.supportsCompaction &&
      !this.props.isPending() &&
      !this.props.isBusy() &&
      !this.status?.activity &&
      !this.compacting
    );
  }
  compacting = false;
  compactionError: string | undefined;
  compactionComplete = false;

  async compact() {
    if (!this.canCompact || this.signal.aborted) return;
    this.compacting = true;
    this.compactionError = undefined;
    this.compactionComplete = false;
    try {
      // Closing the reader cancels reads, not an already authorized compaction.
      await ClientContext.consume(this)!.sessionChats.compactMemory(
        { sessionId: this.props.sessionId },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      await this.refresh();
      if (!this.signal.aborted) this.compactionComplete = true;
    } catch (error) {
      if (!this.signal.aborted) this.compactionError = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.compacting = false;
    }
  }

  open = false;
  loading = false;
  error: string | undefined;
  sources: readonly ContextInspectionNode[] = [];
  expanded: readonly string[] = ["memory"];
  details: Readonly<Record<string, readonly ContextInspectionNode[]>> = {};
  detailErrors: Readonly<Record<string, string>> = {};
  pending: readonly string[] = [];
  private generation = 0;
  private controller: AbortController | undefined;

  get estimatedTokens(): number | undefined {
    if (!this.open || this.loading || this.error) return undefined;
    return estimateContextTokens(this.sources);
  }

  show() {
    if (this.open || this.signal.aborted) return;
    this.open = true;
    void this.refresh();
  }

  close() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    batch(() => {
      this.open = false;
      this.loading = false;
      this.error = undefined;
      this.sources = [];
      this.expanded = ["memory"];
      this.details = {};
      this.detailErrors = {};
      this.pending = [];
    });
  }

  private current(generation: number, signal: AbortSignal) {
    return this.open && generation === this.generation && !signal.aborted;
  }

  async refresh() {
    if (!this.open) return;
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.signal, this.controller.signal]);
    batch(() => {
      this.loading = true;
      this.error = undefined;
      this.sources = [];
      this.details = {};
      this.detailErrors = {};
      this.pending = [];
      this.expanded = ["memory"];
    });
    try {
      // An unsent conversation has no Pi runtime or assembled context to inspect.
      // Do not materialize one merely to browse, or confuse acquisition failure with emptiness.
      if (this.props.isPending()) return;
      const value = await ClientContext.consume(this)!.sessionChats.inspect(
        { sessionId: this.props.sessionId, kind: "context-outline" },
        { signal },
      );
      const inspection = decodeContextInspection(value);
      if (this.current(generation, signal)) this.sources = inspection.sources;
    } catch (error) {
      if (this.current(generation, signal)) this.error = describeError(error).message;
    } finally {
      if (this.current(generation, signal)) this.loading = false;
    }
  }

  toggle(node: ContextInspectionNode) {
    if (this.expanded.includes(node.id)) {
      this.expanded = this.expanded.filter((id) => id !== node.id);
      return;
    }
    this.expanded = [...this.expanded, node.id];
    if (node.detail && !this.details[node.id]) void this.loadDetail(node);
  }

  async loadDetail(node: ContextInspectionNode) {
    if (!node.detail || !this.controller || this.pending.includes(node.id)) return;
    const generation = this.generation;
    const signal = AbortSignal.any([this.signal, this.controller.signal]);
    this.pending = [...this.pending, node.id];
    this.detailErrors = Object.fromEntries(
      Object.entries(this.detailErrors).filter(([id]) => id !== node.id),
    );
    try {
      const value = await ClientContext.consume(this)!.sessionChats.inspect(
        { sessionId: this.props.sessionId, kind: "memory-detail", ...node.detail },
        { signal },
      );
      const detail = decodeContextInspection(value);
      if (this.current(generation, signal))
        this.details = { ...this.details, [node.id]: detail.sources };
    } catch (error) {
      if (this.current(generation, signal))
        this.detailErrors = { ...this.detailErrors, [node.id]: describeError(error).message };
    } finally {
      if (this.current(generation, signal))
        this.pending = this.pending.filter((id) => id !== node.id);
    }
  }
}
