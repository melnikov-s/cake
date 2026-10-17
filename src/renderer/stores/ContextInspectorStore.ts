import { batch, Store } from "r-state-tree";
import {
  decodeContextInspection,
  type ContextInspectionNode,
} from "../../contracts/conversations/context-inspection";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** A window-local reader. Closing releases all content; browsing never calls prompt/compact/zoom tools. */
export class ContextInspectorStore extends Store<{ sessionId: string; isPending(): boolean }> {
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

  constructor(props: ContextInspectorStore["props"]) {
    super(props);
    this.effect(() => () => this.close());
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
