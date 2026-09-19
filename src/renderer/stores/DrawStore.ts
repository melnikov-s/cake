import { Store, observable, snapshot } from "r-state-tree";
import type { DrawBoardMetadata } from "../../domain/draw/draw-board-data";
import type {
  DrawApplyReceipt,
  DrawDocumentSnapshot,
  DrawOperation,
  DrawReadScope,
  DrawRender,
  DrawRenderInput,
  DrawScene,
} from "../../domain/draw/draw-editor";
import { assertPersistableDrawDocument, type DrawEditorAdapter } from "../draw/DrawEditorAdapter";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

export interface DrawStoreProps {
  sessionId: string;
}

const SAVE_DELAY_MS = 500;

/** Owns one Project Session's durable whiteboard workflow and mounted editor adapter. */
export class DrawStore extends Store<DrawStoreProps> {
  @snapshot activeBoardId: string | undefined;
  readonly boards: DrawBoardMetadata[] = observable([]);
  loading = false;
  saving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  documentSnapshot: DrawDocumentSnapshot | null = null;
  private initialized = false;
  private loadRevision = 0;
  private editorAdapter: DrawEditorAdapter | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private dirtyGeneration = 0;
  private savedGeneration = 0;
  private failedSaveGeneration = 0;
  private failedSaveError: Error | undefined;
  private pendingSnapshot:
    | { boardId: string; generation: number; snapshot: DrawDocumentSnapshot }
    | undefined;
  private detachDocumentListener: (() => void) | undefined;
  private readonly readyWaiters = new Set<(adapter: DrawEditorAdapter) => void>();

  get client() {
    return ClientContext.consume(this)!.draw;
  }

  get activeBoard() {
    return this.boards.find((board) => board.id === this.activeBoardId);
  }

  get adapter() {
    return this.editorAdapter;
  }

  async initialize() {
    if (this.initialized || this.loading) return;
    this.loading = true;
    this.clearError();
    try {
      const boards = await this.client.list(
        { sessionId: this.props.sessionId },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      this.boards.splice(0, this.boards.length, ...boards);
      let boardId = this.activeBoardId;
      if (!boardId || !boards.some((board) => board.id === boardId)) {
        boardId = boards[0]?.id;
      }
      if (!boardId) {
        const board = await this.client.create(
          { sessionId: this.props.sessionId, title: "Board 1" },
          { signal: this.signal },
        );
        if (this.signal.aborted) return;
        this.boards.push(board);
        boardId = board.id;
      }
      this.initialized = true;
      await this.loadBoard(boardId);
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    } finally {
      if (!this.signal.aborted) this.loading = false;
    }
  }

  async selectBoard(boardId: string) {
    if (boardId === this.activeBoardId) return;
    if (!this.boards.some((board) => board.id === boardId)) throw new Error("Board not found");
    await this.flush();
    await this.loadBoard(boardId);
  }

  async createBoard(title = `Board ${this.boards.length + 1}`) {
    this.clearError();
    try {
      await this.flush();
      const board = await this.client.create(
        { sessionId: this.props.sessionId, title },
        { signal: this.signal },
      );
      if (this.signal.aborted) return undefined;
      this.boards.push(board);
      await this.loadBoard(board.id);
      return board;
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
      return undefined;
    }
  }

  async renameBoard(boardId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.clearError();
    try {
      const board = await this.client.rename(
        { sessionId: this.props.sessionId, boardId, title: trimmed },
        { signal: this.signal },
      );
      if (!this.signal.aborted) this.replaceBoard(board);
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async deleteBoard(boardId: string) {
    if (this.boards.length <= 1) throw new Error("A session must keep at least one board");
    this.clearError();
    try {
      if (boardId === this.activeBoardId) await this.flush();
      await this.client.delete(
        { sessionId: this.props.sessionId, boardId },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      const index = this.boards.findIndex((board) => board.id === boardId);
      if (index >= 0) this.boards.splice(index, 1);
      if (boardId === this.activeBoardId) {
        const next = this.boards[Math.min(index, this.boards.length - 1)]!;
        await this.loadBoard(next.id);
      }
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  attachEditor(adapter: DrawEditorAdapter) {
    this.detachDocumentListener?.();
    this.editorAdapter = adapter;
    this.detachDocumentListener = adapter.onDocumentChange(() => this.documentChanged());
    for (const resolve of this.readyWaiters) resolve(adapter);
    this.readyWaiters.clear();
  }

  detachEditor(adapter: DrawEditorAdapter) {
    if (this.editorAdapter !== adapter) return;
    this.detachDocumentListener?.();
    this.detachDocumentListener = undefined;
    if (this.dirtyGeneration > this.savedGeneration) this.enqueueSave(adapter.snapshotDocument());
    this.editorAdapter = undefined;
  }

  waitUntilReady() {
    if (this.editorAdapter) return Promise.resolve(this.editorAdapter);
    if (this.signal.aborted) return Promise.reject(new Error("Draw editor was disposed"));
    return new Promise<DrawEditorAdapter>((resolve, reject) => {
      const ready = (adapter: DrawEditorAdapter) => {
        this.signal.removeEventListener("abort", abort);
        resolve(adapter);
      };
      const abort = () => {
        this.readyWaiters.delete(ready);
        reject(new Error("Draw editor was disposed"));
      };
      this.readyWaiters.add(ready);
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }

  async read(scope: DrawReadScope): Promise<DrawScene> {
    return (await this.waitUntilReady()).read({ scope });
  }

  async render(input: DrawRenderInput): Promise<DrawRender> {
    return (await this.waitUntilReady()).render(input);
  }

  async apply(operations: readonly DrawOperation[]): Promise<DrawApplyReceipt> {
    this.clearError();
    const receipt = (await this.waitUntilReady()).apply({ operations });
    await this.flush();
    return receipt;
  }

  async flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const targetGeneration = this.dirtyGeneration;
    if (targetGeneration > this.savedGeneration) {
      const pending = this.pendingSnapshot;
      const snapshot =
        this.editorAdapter?.snapshotDocument() ??
        (pending && pending.boardId === this.activeBoardId ? pending.snapshot : undefined);
      if (snapshot) this.enqueueSave(snapshot);
    }
    await this.saveQueue;
    if (this.savedGeneration < targetGeneration)
      throw (
        this.failedSaveError ??
        new Error("Cake Draw could not persist the latest whiteboard changes")
      );
  }

  private async loadBoard(boardId: string) {
    const revision = ++this.loadRevision;
    this.loading = true;
    this.documentSnapshot = null;
    this.activeBoardId = boardId;
    try {
      const result = await this.client.read(
        { sessionId: this.props.sessionId, boardId },
        { signal: this.signal },
      );
      if (this.signal.aborted || revision !== this.loadRevision) return;
      this.replaceBoard(result.board);
      this.documentSnapshot = result.snapshot;
      this.savedGeneration = this.dirtyGeneration;
    } catch (error) {
      if (!this.signal.aborted && revision === this.loadRevision) this.setError(error);
    } finally {
      if (!this.signal.aborted && revision === this.loadRevision) this.loading = false;
    }
  }

  private documentChanged() {
    this.dirtyGeneration += 1;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (this.editorAdapter) this.enqueueSave(this.editorAdapter.snapshotDocument());
    }, SAVE_DELAY_MS);
  }

  private enqueueSave(snapshot: DrawDocumentSnapshot) {
    const boardId = this.activeBoardId;
    if (!boardId) return;
    assertPersistableDrawDocument(snapshot);
    const generation = this.dirtyGeneration;
    this.pendingSnapshot = { boardId, generation, snapshot };
    if (boardId === this.activeBoardId) this.documentSnapshot = snapshot;
    this.saveQueue = this.saveQueue.then(async () => {
      const board = this.boards.find((candidate) => candidate.id === boardId);
      if (!board || this.signal.aborted) return;
      this.saving = true;
      try {
        const updated = await this.client.save(
          {
            sessionId: this.props.sessionId,
            boardId,
            expectedRevision: board.revision,
            snapshot,
          },
          { signal: this.signal },
        );
        if (this.signal.aborted) return;
        this.replaceBoard(updated);
        if (boardId === this.activeBoardId) {
          this.savedGeneration = generation;
          if (
            this.pendingSnapshot?.boardId === boardId &&
            this.pendingSnapshot.generation <= generation
          )
            this.pendingSnapshot = undefined;
          if (this.failedSaveGeneration <= generation) {
            this.failedSaveGeneration = 0;
            this.failedSaveError = undefined;
            this.clearError();
          }
        }
      } catch (error) {
        if (!this.signal.aborted) {
          this.failedSaveGeneration = generation;
          this.failedSaveError = error instanceof Error ? error : new Error(String(error));
          this.setError(error);
        }
      } finally {
        if (!this.signal.aborted) this.saving = false;
      }
    });
  }

  private replaceBoard(board: DrawBoardMetadata) {
    const index = this.boards.findIndex((candidate) => candidate.id === board.id);
    if (index >= 0) this.boards.splice(index, 1, board);
    else this.boards.push(board);
  }

  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }

  private setError(error: unknown) {
    const described = describeError(error, "Cake Draw");
    this.error = described.message;
    this.errorDetails = described.details;
  }
}
