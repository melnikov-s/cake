import { Store, observable, snapshot } from "r-state-tree";
import type { DrawBoardMetadata } from "../../domain/draw/draw-board-data";
import type {
  DrawApplyReceipt,
  DrawDocumentSnapshot,
  DrawMermaidReceipt,
  DrawOperation,
  DrawReadScope,
  DrawRender,
  DrawRenderInput,
  DrawScene,
} from "../../domain/draw/draw-editor";
import type { DrawEditorAdapter } from "../draw/DrawEditorAdapter";
import { assertPersistableDrawDocument } from "../draw/DrawDocumentValidation";
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
  agentDrawing = false;
  exportingFormat: "png" | "svg" | "excalidraw" | undefined;
  exportMessage: string | undefined;
  error: string | undefined;
  errorDetails: string | undefined;
  documentLoaded = false;
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
  private suppressDocumentChanges = false;
  private readonly checkpoints = new Map<string, DrawDocumentSnapshot>();
  private checkpointOrder: string[] = [];
  lastCheckpointId: string | undefined;
  private readonly readyWaiters = new Set<(adapter: DrawEditorAdapter) => void>();

  get client() {
    return ClientContext.consume(this)!.draw;
  }

  get electron() {
    return ClientContext.consume(this)!.electron;
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

  async exportDocument() {
    return (await this.waitUntilReady()).exportDocument();
  }

  async exportBoard(format: "png" | "svg" | "excalidraw") {
    if (this.exportingFormat) return;
    this.clearError();
    this.exportMessage = undefined;
    this.exportingFormat = format;
    try {
      const adapter = await this.waitUntilReady();
      const data =
        format === "excalidraw"
          ? adapter.exportDocument()
          : (
              await adapter.render({
                scope: "page",
                format,
                background: true,
                scale: 1,
              })
            ).data;
      const title = Array.from(this.activeBoard?.title ?? "Cake Draw")
        .map((character) =>
          character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/u.test(character) ? "-" : character,
        )
        .join("")
        .trim();
      const path = await this.electron.saveDrawExport(
        { format, suggestedName: title || "Cake Draw", data },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      this.exportMessage = path ? `Exported ${format.toUpperCase()}` : "Export cancelled";
      return path;
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
      return undefined;
    } finally {
      if (!this.signal.aborted) this.exportingFormat = undefined;
    }
  }

  async apply(operations: readonly DrawOperation[]): Promise<DrawApplyReceipt> {
    if (this.agentDrawing) throw new Error("Cake Draw is already presenting an agent edit");
    this.clearError();
    const adapter = await this.waitUntilReady();
    const beforePlayback = JSON.stringify(adapter.snapshotDocument());
    this.agentDrawing = true;
    this.suppressDocumentChanges = true;
    try {
      let receipt: DrawApplyReceipt;
      try {
        receipt = await adapter.applyAnimated(
          { operations },
          { stepDelayMs: 160, maxDurationMs: 3_500, signal: this.signal },
        );
      } catch (error) {
        adapter.loadDocument(JSON.parse(beforePlayback));
        throw error;
      }
      this.rememberCheckpoint(JSON.parse(beforePlayback));
      this.suppressDocumentChanges = false;
      this.documentChanged();
      await this.flush();
      return receipt;
    } finally {
      this.suppressDocumentChanges = false;
      this.agentDrawing = false;
    }
  }

  async insertMermaid(
    diagram: string,
    options?: { readonly id?: string; readonly replace?: boolean },
  ): Promise<DrawMermaidReceipt> {
    if (this.agentDrawing) throw new Error("Cake Draw is already presenting an agent edit");
    this.clearError();
    const adapter = await this.waitUntilReady();
    const before = adapter.snapshotDocument();
    this.agentDrawing = true;
    this.suppressDocumentChanges = true;
    try {
      const receipt = await adapter.insertMermaid(diagram, options);
      this.suppressDocumentChanges = false;
      this.documentChanged();
      await this.flush();
      this.rememberCheckpoint(before);
      return receipt;
    } catch (error) {
      this.suppressDocumentChanges = true;
      adapter.loadDocument(before);
      this.suppressDocumentChanges = false;
      this.documentChanged();
      await this.flush().catch(() => undefined);
      throw error;
    } finally {
      this.suppressDocumentChanges = false;
      this.agentDrawing = false;
    }
  }

  async clear(): Promise<DrawApplyReceipt> {
    if (this.agentDrawing) throw new Error("Cake Draw is already presenting an agent edit");
    const adapter = await this.waitUntilReady();
    const before = adapter.snapshotDocument();
    this.agentDrawing = true;
    try {
      const receipt = adapter.clear();
      this.rememberCheckpoint(before);
      this.documentChanged();
      await this.flush();
      return receipt;
    } finally {
      this.agentDrawing = false;
    }
  }

  async undo(checkpointId?: string): Promise<{ checkpointId: string; receipt: DrawApplyReceipt }> {
    if (this.agentDrawing) throw new Error("Cake Draw is already presenting an agent edit");
    const target = checkpointId ?? this.checkpointOrder.at(-1);
    if (!target) throw new Error("There is no agent Draw checkpoint to undo");
    const snapshot = this.checkpoints.get(target);
    if (!snapshot) throw new Error(`Draw checkpoint is no longer available: ${target}`);
    const adapter = await this.waitUntilReady();
    this.agentDrawing = true;
    this.suppressDocumentChanges = true;
    try {
      adapter.loadDocument(snapshot);
      this.suppressDocumentChanges = false;
      const targetIndex = this.checkpointOrder.indexOf(target);
      for (const id of this.checkpointOrder.slice(targetIndex)) this.checkpoints.delete(id);
      this.checkpointOrder = this.checkpointOrder.slice(0, targetIndex);
      this.lastCheckpointId = this.checkpointOrder.at(-1);
      this.documentChanged();
      await this.flush();
      return {
        checkpointId: target,
        receipt: { createdIds: [], updatedIds: [], deletedIds: [] },
      };
    } finally {
      this.suppressDocumentChanges = false;
      this.agentDrawing = false;
    }
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

  private rememberCheckpoint(
    snapshot: DrawDocumentSnapshot,
    checkpointId: string = crypto.randomUUID(),
  ) {
    this.checkpoints.set(checkpointId, snapshot);
    this.checkpointOrder.push(checkpointId);
    while (this.checkpointOrder.length > 10) {
      const expired = this.checkpointOrder.shift();
      if (expired) this.checkpoints.delete(expired);
    }
    this.lastCheckpointId = checkpointId;
    return checkpointId;
  }

  private async loadBoard(boardId: string) {
    const revision = ++this.loadRevision;
    this.loading = true;
    this.documentLoaded = false;
    this.documentSnapshot = null;
    this.checkpoints.clear();
    this.checkpointOrder = [];
    this.lastCheckpointId = undefined;
    this.activeBoardId = boardId;
    try {
      const result = await this.client.read(
        { sessionId: this.props.sessionId, boardId },
        { signal: this.signal },
      );
      if (this.signal.aborted || revision !== this.loadRevision) return;
      this.replaceBoard(result.board);
      this.documentSnapshot = result.snapshot;
      this.documentLoaded = true;
      this.savedGeneration = this.dirtyGeneration;
    } catch (error) {
      if (!this.signal.aborted && revision === this.loadRevision) this.setError(error);
    } finally {
      if (!this.signal.aborted && revision === this.loadRevision) this.loading = false;
    }
  }

  private documentChanged() {
    if (this.suppressDocumentChanges) return;
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
