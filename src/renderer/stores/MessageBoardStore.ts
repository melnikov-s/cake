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

  constructor(props: MessageBoardStore["props"]) {
    super(props);
    this.effect(() => {
      const boardId = this.props.boardId;
      untracked(() => {
        if (boardId) void this.refresh();
      });
    });
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  async refresh() {
    this.request += 1;
    this.loading = false;
    this.entries = [];
    this.bodies = {};
    this.receipts = {};
    this.expanded = [];
    this.showingReceipts = [];
    this.after = 0;
    this.hasMore = false;
    this.error = undefined;
    await this.loadMore();
  }
  async loadMore() {
    const boardId = this.props.boardId;
    if (!boardId || this.loading) return;
    const request = this.request;
    this.loading = true;
    this.error = undefined;
    try {
      const page = await this.client.artifacts.boardEntries(
        { lineageId: boardId, after: this.after, limit: 20 },
        { signal: this.signal },
      );
      if (this.signal.aborted || request !== this.request || boardId !== this.props.boardId) return;
      this.entries = [...this.entries, ...page.entries];
      this.after = page.nextAfter;
      this.hasMore = page.hasMore;
    } catch (error) {
      if (!this.signal.aborted && request === this.request)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.request) this.loading = false;
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
        { signal: this.signal },
      );
      if (!this.signal.aborted && request === this.request && boardId === this.props.boardId)
        this.bodies = { ...this.bodies, [sequence]: body };
    } catch (error) {
      if (!this.signal.aborted && request === this.request) {
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
    const boardId = this.props.boardId;
    if (!boardId) return;
    const request = this.request;
    try {
      const receipts = await this.client.artifacts.boardReceipts(
        { lineageId: boardId, sequence },
        { signal: this.signal },
      );
      if (!this.signal.aborted && request === this.request && boardId === this.props.boardId)
        this.receipts = { ...this.receipts, [sequence]: receipts };
    } catch (error) {
      if (!this.signal.aborted && request === this.request) {
        this.error = error instanceof Error ? error.message : String(error);
        this.showingReceipts = this.showingReceipts.filter((value) => value !== sequence);
      }
    }
  }
}
