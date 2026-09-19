import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { DrawBoardMetadata } from "../../../../src/domain/draw/draw-board-data";
import type { DrawDocumentSnapshot } from "../../../../src/domain/draw/draw-editor";
import type { Client } from "../../../../src/renderer/client/Client";
import type { DrawEditorAdapter } from "../../../../src/renderer/draw/DrawEditorAdapter";
import { DrawStore } from "../../../../src/renderer/stores/DrawStore";
import { mountWithClient } from "../mount-with-client";

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

function mountDrawStore(boards: DrawBoardMetadata[] = [firstBoard, secondBoard]) {
  const save = vi.fn(async (input: { boardId: string; expectedRevision: number }) => {
    const board = boards.find((candidate) => candidate.id === input.boardId)!;
    const updated = { ...board, revision: input.expectedRevision + 1 };
    boards.splice(boards.indexOf(board), 1, updated);
    return updated;
  });
  const draw = {
    list: vi.fn(async () => [...boards]),
    create: vi.fn(async ({ sessionId, title }: { sessionId: string; title: string }) => {
      const board = {
        ...firstBoard,
        id: "33333333-3333-4333-8333-333333333333",
        sessionId,
        title,
      };
      boards.push(board);
      return board;
    }),
    read: vi.fn(async ({ boardId }: { boardId: string }) => ({
      board: boards.find((board) => board.id === boardId)!,
      snapshot: emptyDocument,
    })),
    save,
    rename: vi.fn(),
    delete: vi.fn(),
  };
  const mounted = mountWithClient(createStore(DrawStore, { sessionId: "session-1" }), {
    draw,
  } as unknown as Client);
  return { ...mounted, draw, save };
}

function adapterHarness(snapshot: DrawDocumentSnapshot = emptyDocument) {
  let listener: (() => void) | undefined;
  const apply = vi.fn<DrawEditorAdapter["applyAnimated"]>(async () => ({
    createdIds: [],
    updatedIds: ["shape:one"],
    deletedIds: [],
  }));
  const adapter = {
    snapshotDocument: () => snapshot,
    onDocumentChange: (next: () => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    read: vi.fn(),
    render: vi.fn(),
    apply: vi.fn(),
    applyAnimated: apply,
    loadDocument: vi.fn(),
  } as unknown as DrawEditorAdapter;
  return { adapter, apply, change: () => listener?.() };
}

describe("DrawStore", () => {
  it("restores the remembered board and loads its document", async () => {
    const { subject, draw } = mountDrawStore();
    subject.activeBoardId = secondBoard.id;

    expect(subject.documentLoaded).toBe(false);

    await subject.initialize();

    expect(subject.activeBoard?.id).toBe(secondBoard.id);
    expect(subject.documentLoaded).toBe(true);
    expect(subject.documentSnapshot).toEqual(emptyDocument);
    expect(draw.read).toHaveBeenCalledWith(
      { sessionId: "session-1", boardId: secondBoard.id },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("flushes the current document before switching boards", async () => {
    const { subject, save, draw } = mountDrawStore();
    await subject.initialize();
    const editor = adapterHarness();
    subject.attachEditor(editor.adapter);
    editor.change();

    await subject.selectBoard(secondBoard.id);

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: firstBoard.id,
        expectedRevision: 0,
        snapshot: emptyDocument,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(draw.read).toHaveBeenLastCalledWith(
      { sessionId: "session-1", boardId: secondBoard.id },
      expect.anything(),
    );
  });

  it("keeps the current board open when its dirty document cannot be saved", async () => {
    const { subject, save, draw } = mountDrawStore();
    await subject.initialize();
    const changedDocument: DrawDocumentSnapshot = {
      ...emptyDocument,
      appState: { viewBackgroundColor: "#f8f9fa" },
    };
    const editor = adapterHarness(changedDocument);
    subject.attachEditor(editor.adapter);
    editor.change();
    save.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(subject.selectBoard(secondBoard.id)).rejects.toThrow("storage unavailable");

    expect(subject.activeBoardId).toBe(firstBoard.id);
    expect(draw.read).toHaveBeenCalledTimes(1);
    expect(subject.documentSnapshot).toEqual(changedDocument);

    await expect(subject.selectBoard(secondBoard.id)).resolves.toBeUndefined();
    expect(subject.activeBoardId).toBe(secondBoard.id);
    expect(draw.read).toHaveBeenCalledTimes(2);
  });

  it("waits for the editor adapter to mount before applying agent operations", async () => {
    const { subject } = mountDrawStore();
    await subject.initialize();
    const editor = adapterHarness();

    const applying = subject.apply([
      {
        type: "create",
        shape: { id: "one", type: "geo", x: 0, y: 0, width: 100, height: 80 },
      },
    ]);
    let settled = false;
    void applying.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(editor.apply).not.toHaveBeenCalled();

    subject.attachEditor(editor.adapter);

    await expect(applying).resolves.toEqual({
      createdIds: [],
      updatedIds: ["shape:one"],
      deletedIds: [],
    });
    expect(editor.apply).toHaveBeenCalledOnce();
  });

  it("owns visible agent playback and persists only the final scene", async () => {
    const { subject, save } = mountDrawStore();
    await subject.initialize();
    const editor = adapterHarness();
    let finishPlayback!: () => void;
    editor.apply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPlayback = () =>
            resolve({ createdIds: ["shape:one"], updatedIds: [], deletedIds: [] });
        }),
    );
    subject.attachEditor(editor.adapter);

    const applying = subject.apply([
      {
        type: "create",
        shape: { id: "one", type: "geo", x: 0, y: 0, width: 100, height: 80 },
      },
    ]);
    await Promise.resolve();
    expect(subject.agentDrawing).toBe(true);
    editor.change();
    expect(save).not.toHaveBeenCalled();

    finishPlayback();
    await expect(applying).resolves.toEqual({
      createdIds: ["shape:one"],
      updatedIds: [],
      deletedIds: [],
    });
    expect(subject.agentDrawing).toBe(false);
    expect(save).toHaveBeenCalledOnce();
  });

  it("rejects an explicit apply when persistence fails and retries the dirty generation", async () => {
    const { subject, save } = mountDrawStore();
    await subject.initialize();
    const editor = adapterHarness();
    subject.attachEditor(editor.adapter);
    editor.change();
    save.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      subject.apply([{ type: "move", ids: ["shape:one"], deltaX: 10, deltaY: 0 }]),
    ).rejects.toThrow("disk full");

    expect(editor.apply).toHaveBeenCalledOnce();
    expect(editor.apply).toHaveBeenCalledWith(
      { operations: [{ type: "move", ids: ["shape:one"], deltaX: 10, deltaY: 0 }] },
      expect.objectContaining({ stepDelayMs: 160, maxDurationMs: 3_500 }),
    );
    expect(subject.activeBoard?.revision).toBe(0);
    expect(subject.error).toContain("disk full");

    await expect(subject.flush()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ boardId: firstBoard.id, expectedRevision: 0 }),
      expect.anything(),
    );
    expect(subject.activeBoard?.revision).toBe(1);
    expect(subject.error).toBeUndefined();
  });

  it("creates a default board when the session has none", async () => {
    const { subject, draw } = mountDrawStore([]);

    await subject.initialize();

    expect(draw.create).toHaveBeenCalledWith(
      { sessionId: "session-1", title: "Board 1" },
      expect.anything(),
    );
    expect(subject.activeBoardId).toBe("33333333-3333-4333-8333-333333333333");
  });
});
