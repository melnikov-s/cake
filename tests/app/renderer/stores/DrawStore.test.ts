/**
 * Retained native-boundary integration backlog, composed through real Root/Registry/Draw Stores.
 * App board opening/loading/retry/default-board journeys live in draw-workflow.test.tsx; its reads
 * stay pending because Excalidraw cannot honestly mount in jsdom without native rendering shims.
 * Successful native exports and checkpoint undo are covered by tests/electron/draw.smoke.spec.ts
 * and the real tool/DrawStore/adapter integration in DrawEditorAdapter.test.ts. Named Mermaid
 * conversion/persistence is covered by draw-mermaid-architecture.smoke.spec.ts.
 *
 * Keep the uncovered recovered-document, dirty-board failure/retry, export cancellation/failure,
 * readiness/completion gating, rollback and failed-save contracts below. The fully typed editor
 * boundary supplies documents and completion/error signals, not a canvas or geometry algorithm.
 * These tests prove real Store coordination and durable outcomes, NOT native rendering, visible
 * playback, pointer editing, export serialization, focus or geometry. No invented GUI controls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DrawBoardMetadata } from "../../../../src/contracts/draw/draw-board-data";
import type { DrawDocumentSnapshot } from "../../../../src/contracts/draw/draw-editor";
import type { Client } from "../../../../src/renderer/client/Client";
import type { DrawEditorAdapter } from "../../../../src/renderer/draw/DrawEditorAdapter";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const firstBoard: DrawBoardMetadata = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "session-1",
  title: "Board 1",
  revision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const secondBoard: DrawBoardMetadata = {
  ...firstBoard,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Board 2",
};
const emptyDocument: DrawDocumentSnapshot = {
  type: "cake-excalidraw",
  version: 1,
  source: "cake",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
};
// A controlled document from the native boundary, with no fabricated element geometry.
const editedDocument: DrawDocumentSnapshot = {
  ...emptyDocument,
  appState: { viewBackgroundColor: "#f8f9fa" },
};
const emptyReceipt = { createdIds: [], updatedIds: [], deletedIds: [] };

function mountDraw() {
  const boards = [{ ...firstBoard }, { ...secondBoard }];
  const documents = new Map(boards.map((board) => [board.id, emptyDocument]));
  const findBoard = (id: string) => {
    const board = boards.find((candidate) => candidate.id === id);
    if (!board) throw new Error(`Unknown board ${id}`);
    return board;
  };
  const save = vi.fn<Client["draw"]["save"]>(async (input) => {
    const board = findBoard(input.boardId);
    if (input.expectedRevision !== board.revision) throw new Error("Revision conflict");
    const updated = { ...board, revision: board.revision + 1 };
    boards.splice(boards.indexOf(board), 1, updated);
    documents.set(board.id, input.snapshot);
    return updated;
  });
  const read = vi.fn<Client["draw"]["read"]>(async ({ boardId }) => ({
    board: findBoard(boardId),
    snapshot: documents.get(boardId)!,
  }));
  const saveDrawExport = vi.fn<Client["electron"]["saveDrawExport"]>(
    async () => "/tmp/Board 1.excalidraw",
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
    client: {
      draw: { list: async () => [...boards], read, save },
      electron: { saveDrawExport },
    },
  });
  const subject = fixture.root.sessionRegistry.load("session-1", "/project").drawStore;
  return {
    subject,
    save,
    read,
    saveDrawExport,
    persisted(boardId = firstBoard.id) {
      return { board: findBoard(boardId), document: documents.get(boardId) };
    },
    [Symbol.dispose]() {
      fixture[Symbol.dispose]();
    },
  };
}

function editorBoundary() {
  let document = emptyDocument;
  const apply = vi.fn<DrawEditorAdapter["applyAnimated"]>(async () => emptyReceipt);
  const insertMermaid = vi.fn<DrawEditorAdapter["insertMermaid"]>(async () => ({
    elementCount: 0,
    mappings: [],
  }));
  const adapter: DrawEditorAdapter = {
    snapshotDocument: () => document,
    loadDocument: (snapshot) => {
      document = snapshot;
    },
    // Export outcome tests consume an external serialized document, not its serializer.
    exportDocument: () =>
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: [],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    read: () => {
      throw new Error("Unexpected native scene read");
    },
    render: async () => {
      throw new Error("Unexpected native render");
    },
    apply: () => {
      throw new Error("Unexpected synchronous edit");
    },
    clear: () => {
      throw new Error("Unexpected clear");
    },
    applyAnimated: apply,
    insertMermaid,
  };
  return {
    adapter,
    apply,
    insertMermaid,
    replaceDocument(snapshot: DrawDocumentSnapshot) {
      document = snapshot;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("Draw native-boundary coordination through Root", () => {
  it("loads the recovered document after opening retry succeeds", async () => {
    using fixture = mountDraw();
    fixture.read.mockRejectedValueOnce(new Error("read unavailable"));
    await fixture.subject.initialize();
    expect(fixture.subject.documentLoaded).toBe(false);

    await fixture.subject.retry();

    expect(fixture.subject.documentLoaded).toBe(true);
    expect(fixture.subject.activeBoard).toEqual(firstBoard);
    expect(fixture.subject.documentSnapshot).toEqual(fixture.persisted().document);
    expect(fixture.subject.error).toBeUndefined();
  });

  it("keeps a dirty board open until its save succeeds, including after a failed switch and retry", async () => {
    using fixture = mountDraw();
    await fixture.subject.initialize();
    const editor = editorBoundary();
    fixture.subject.attachEditor(editor.adapter);
    editor.replaceDocument(editedDocument);
    fixture.subject.editorChanged();
    const started = deferred();
    const finish = deferred();
    fixture.save.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      throw new Error("storage unavailable");
    });

    const switching = fixture.subject.selectBoard(secondBoard.id);
    await started.promise;
    expect(fixture.subject.activeBoard).toEqual(firstBoard);
    expect(fixture.persisted()).toEqual({ board: firstBoard, document: emptyDocument });
    finish.resolve();
    await expect(switching).rejects.toThrow("storage unavailable");
    expect(fixture.subject.activeBoard).toEqual(firstBoard);
    expect(fixture.subject.documentSnapshot).toEqual(editedDocument);

    await fixture.subject.selectBoard(secondBoard.id);

    expect(fixture.persisted()).toEqual({
      board: { ...firstBoard, revision: 1 },
      document: editedDocument,
    });
    expect(fixture.subject.activeBoard).toEqual(secondBoard);
    expect(fixture.subject.documentSnapshot).toEqual(emptyDocument);
    expect(fixture.subject.error).toBeUndefined();
  });

  it.each(["cancelled", "failed"] as const)(
    "reports a %s native export without false success or a storage mutation",
    async (outcome) => {
      using fixture = mountDraw();
      await fixture.subject.initialize();
      fixture.subject.attachEditor(editorBoundary().adapter);
      if (outcome === "cancelled") fixture.saveDrawExport.mockResolvedValueOnce(undefined);
      else fixture.saveDrawExport.mockRejectedValueOnce(new Error("native save failed"));

      await expect(fixture.subject.exportBoard("excalidraw")).resolves.toBeUndefined();

      expect(fixture.subject.exportingFormat).toBeUndefined();
      expect(fixture.persisted()).toEqual({ board: firstBoard, document: emptyDocument });
      if (outcome === "cancelled") {
        expect(fixture.subject.exportMessage).toBe("Export cancelled");
        expect(fixture.subject.error).toBeUndefined();
      } else {
        expect(fixture.subject.error).toContain("native save failed");
        expect(fixture.subject.exportMessage).toBeUndefined();
      }
    },
  );

  it("waits for native readiness and completion, rejects overlapping edits and persists only the completed document", async () => {
    using fixture = mountDraw();
    await fixture.subject.initialize();
    const editor = editorBoundary();
    const started = deferred();
    const finish = deferred();
    editor.apply.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return emptyReceipt;
    });
    const applying = fixture.subject.apply([{ type: "select", ids: [] }]);
    let settled = false;
    void applying.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fixture.persisted()).toEqual({ board: firstBoard, document: emptyDocument });

    fixture.subject.attachEditor(editor.adapter);
    await started.promise;
    expect(fixture.subject.agentDrawing).toBe(true);
    await expect(fixture.subject.apply([{ type: "select", ids: [] }])).rejects.toThrow(
      "already presenting an agent edit",
    );
    // Control the Store debounce clock and native completion separately. This
    // boundary notification is not proof of visible/native progressive playback.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    editor.replaceDocument(editedDocument);
    fixture.subject.editorChanged();
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.persisted()).toEqual({ board: firstBoard, document: emptyDocument });

    finish.resolve();
    await expect(applying).resolves.toEqual(emptyReceipt);
    expect(fixture.subject.agentDrawing).toBe(false);
    expect(fixture.persisted()).toEqual({
      board: { ...firstBoard, revision: 1 },
      document: editedDocument,
    });
  });

  it("restores the native boundary's original document after an unsuccessful agent edit", async () => {
    using fixture = mountDraw();
    await fixture.subject.initialize();
    const editor = editorBoundary();
    editor.apply.mockImplementationOnce(async () => {
      editor.replaceDocument(editedDocument);
      throw new Error("native edit failed");
    });
    fixture.subject.attachEditor(editor.adapter);

    await expect(fixture.subject.apply([{ type: "select", ids: [] }])).rejects.toThrow(
      "native edit failed",
    );

    expect(editor.adapter.snapshotDocument()).toEqual(emptyDocument);
    expect(fixture.subject.agentDrawing).toBe(false);
    expect(fixture.subject.lastCheckpointId).toBeUndefined();
    expect(fixture.persisted()).toEqual({ board: firstBoard, document: emptyDocument });
  });

  it("restores and persists the pre-conversion document when Mermaid persistence fails", async () => {
    using fixture = mountDraw();
    await fixture.subject.initialize();
    const editor = editorBoundary();
    editor.insertMermaid.mockImplementationOnce(async () => {
      editor.replaceDocument(editedDocument);
      return { elementCount: 0, mappings: [] };
    });
    fixture.subject.attachEditor(editor.adapter);
    fixture.save.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(fixture.subject.insertMermaid("flowchart LR\nA --> B")).rejects.toThrow(
      "storage unavailable",
    );

    expect(editor.adapter.snapshotDocument()).toEqual(emptyDocument);
    expect(fixture.subject.lastCheckpointId).toBeUndefined();
    expect(fixture.subject.agentDrawing).toBe(false);
    expect(fixture.persisted()).toEqual({
      board: { ...firstBoard, revision: 1 },
      document: emptyDocument,
    });
  });

  it("rejects an Apply save failure and retries the same dirty document without advancing a failed revision", async () => {
    using fixture = mountDraw();
    await fixture.subject.initialize();
    const editor = editorBoundary();
    fixture.subject.attachEditor(editor.adapter);
    editor.replaceDocument(editedDocument);
    fixture.subject.editorChanged();
    fixture.save.mockRejectedValueOnce(new Error("disk full"));

    await expect(fixture.subject.apply([{ type: "select", ids: [] }])).rejects.toThrow("disk full");
    expect(fixture.subject.activeBoard?.revision).toBe(0);
    expect(fixture.subject.error).toContain("disk full");
    expect(fixture.persisted()).toEqual({ board: firstBoard, document: emptyDocument });

    await fixture.subject.flush();

    expect(fixture.subject.activeBoard?.revision).toBe(1);
    expect(fixture.subject.error).toBeUndefined();
    expect(fixture.persisted()).toEqual({
      board: { ...firstBoard, revision: 1 },
      document: editedDocument,
    });
  });
});
