import { Store, untracked } from "r-state-tree";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import type {
  BoardDescription,
  BoardEntry,
  BoardEntryReceipts,
} from "../../contracts/artifacts/message-board";
import { ClientContext } from "./context/ClientContext";

/** Viewer-owned, disposable pages and expansion state; backend owns entries and receipts. */
export class MessageBoardStore extends Store<{ boardId?: ArtifactLineageId }> {
  entries: ReadonlyArray<BoardDescription> = [];
  bodies: Record<number, BoardEntry> = {};
  receipts: Record<number, BoardEntryReceipts> = {};
  expanded: ReadonlyArray<number> = [];
  showingReceipts: ReadonlyArray<number> = [];
  loading = false;
  hasMore = false;
  after = 0;
  error: string | undefined;
  private request = 0;
  private pending = false;
  private controller: AbortController | undefined;
  private receiptRequests: Record<number, number> = {};

  constructor(props: MessageBoardStore["props"]) {
    super(props);
    this.effect(() => {
      const boardId = this.props.boardId;
      return untracked(() => {
        this.request += 1;
        this.controller = new AbortController();
        const controller = this.controller;
        this.loading = false;
        this.pending = false;
        this.entries = [];
        this.bodies = {};
        this.receipts = {};
        this.expanded = [];
        this.showingReceipts = [];
        this.receiptRequests = {};
        this.after = 0;
        this.hasMore = false;
        this.error = undefined;
        if (boardId) void this.loadMore();
        return () => controller.abort();
      });
    });
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  private isCurrent(request: number, boardId: ArtifactLineageId) {
    return !this.signal.aborted && request === this.request && boardId === this.props.boardId;
  }
  private get operationSignal() {
    return AbortSignal.any([this.signal, ...(this.controller ? [this.controller.signal] : [])]);
  }

  /** Coalesce ordered invalidations; an event during a query always gets a follow-up query. */
  receive() {
    if (!this.props.boardId || this.signal.aborted) return;
    this.pending = true;
    if (!this.loading) void this.loadMore(true);
  }

  async loadMore(catchUp = false) {
    const boardId = this.props.boardId;
    if (!boardId || this.loading || this.signal.aborted) return;
    const request = this.request;
    const signal = this.operationSignal;
    this.loading = true;
    this.error = undefined;
    try {
      do {
        this.pending = false;
        // Entries are immutable and ordered: append after the loaded cursor, never replace
        // existing rows or clear their bodies/expansions (including during background updates).
        do {
          const page = await this.client.artifacts.boardEntries(
            { lineageId: boardId, after: this.after, limit: 20 },
            { signal },
          );
          if (!this.isCurrent(request, boardId)) return;
          this.entries = [...this.entries, ...page.entries];
          this.after = page.nextAfter;
          this.hasMore = page.hasMore;
        } while (catchUp && this.hasMore);
        if (catchUp)
          await Promise.all(this.showingReceipts.map((sequence) => this.loadReceipts(sequence)));
        if (!this.isCurrent(request, boardId)) return;
        catchUp = true;
      } while (this.pending);
    } catch (error) {
      if (this.isCurrent(request, boardId))
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.isCurrent(request, boardId)) {
        this.loading = false;
        if (this.pending) this.receive();
      }
    }
  }
  async toggleBody(sequence: number) {
    if (this.expanded.includes(sequence)) {
      this.expanded = this.expanded.filter((value) => value !== sequence);
      return;
    }
    this.expanded = [...this.expanded, sequence];
    const boardId = this.props.boardId;
    if (!boardId || this.bodies[sequence]) return;
    const request = this.request;
    try {
      const body = await this.client.artifacts.boardBody(
        { lineageId: boardId, sequence },
        { signal: this.operationSignal },
      );
      if (this.isCurrent(request, boardId)) this.bodies = { ...this.bodies, [sequence]: body };
    } catch (error) {
      if (this.isCurrent(request, boardId)) {
        this.error = error instanceof Error ? error.message : String(error);
        this.expanded = this.expanded.filter((value) => value !== sequence);
      }
    }
  }
  async toggleReceipts(sequence: number) {
    if (this.showingReceipts.includes(sequence)) {
      this.showingReceipts = this.showingReceipts.filter((value) => value !== sequence);
      return;
    }
    this.showingReceipts = [...this.showingReceipts, sequence];
    await this.loadReceipts(sequence);
  }
  private async loadReceipts(sequence: number) {
    const boardId = this.props.boardId;
    if (!boardId) return;
    const request = this.request;
    const receiptRequest = (this.receiptRequests[sequence] ?? 0) + 1;
    this.receiptRequests = { ...this.receiptRequests, [sequence]: receiptRequest };
    try {
      const receipts = await this.client.artifacts.boardReceipts(
        { lineageId: boardId, sequence },
        { signal: this.operationSignal },
      );
      if (this.isCurrent(request, boardId) && this.receiptRequests[sequence] === receiptRequest)
        this.receipts = { ...this.receipts, [sequence]: receipts };
    } catch (error) {
      if (this.isCurrent(request, boardId) && this.receiptRequests[sequence] === receiptRequest)
        this.error = error instanceof Error ? error.message : String(error);
    }
  }
}
