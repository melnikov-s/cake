import { describe, expect, it, vi } from "vitest";
import type { DrawBoardMetadata } from "../../../../src/contracts/draw/draw-board-data";
import type { DrawDocumentSnapshot } from "../../../../src/contracts/draw/draw-editor";
import type { DrawEditorAdapter } from "../../../../src/renderer/draw/DrawEditorAdapter";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { sessionSummary } from "../fixtures/catalog-fixtures";

const board: DrawBoardMetadata = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "background",
  title: "Board 1",
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const document: DrawDocumentSnapshot = {
  type: "cake-excalidraw",
  version: 1,
  source: "cake",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
};
const receipt = { createdIds: ["shape:agent"], updatedIds: [], deletedIds: [] };
const scene = {
  pageId: "page:default",
  viewportBounds: { x: 0, y: 0, width: 800, height: 600 },
  selectedShapeIds: [],
  shapes: [],
  truncated: false,
};
function editor(): DrawEditorAdapter {
  return {
    loadDocument: () => undefined,
    snapshotDocument: () => document,
    exportDocument: () => JSON.stringify(document),
    read: () => scene,
    render: async () => {
      throw new Error("Unexpected render");
    },
    apply: () => receipt,
    applyAnimated: async () => receipt,
    insertMermaid: async () => {
      throw new Error("Unexpected Mermaid");
    },
    clear: () => receipt,
  };
}

// Agent requests have no accessible user action. Exercise real Root/Registry/Draw Stores;
// only the external persistence service and native editor adapter are controlled boundaries.
describe("Draw control routing", () => {
  it("enters a loaded background session without changing the focused presentation", async () => {
    const list = vi.fn(async () => [board]);
    using fixture = createRendererStoreFixture({
      client: { draw: { list, read: async () => ({ board, snapshot: document }) } },
    });
    const focused = fixture.root.sessionRegistry.load("focused", "/project");
    const background = fixture.root.sessionRegistry.load("background", "/project");
    background.drawStore.attachEditor(editor());
    fixture.root.appShellStore.selectProjectSession("focused");
    fixture.root.projectWorkbenchStore.showLoadedSession("focused");

    await expect(
      fixture.root.drawControlStore.invoke("background", { _tag: "Enter" }),
    ).resolves.toMatchObject({
      ok: true,
      kind: "entered",
      board,
    });
    expect(background.presentationMode).toBe("draw");
    expect(focused.presentationMode).toBe("normal");
    expect(fixture.root.projectWorkbenchStore.activeSessionId).toBe("focused");
    expect(list).toHaveBeenCalledOnce();
  });

  it("waits for checkpoint persistence before acknowledging Apply", async () => {
    let finishSave!: () => void;
    let saveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    using fixture = createRendererStoreFixture({
      client: {
        draw: {
          list: async () => [board],
          read: async () => ({ board, snapshot: document }),
          save: () => {
            saveStarted();
            return new Promise((resolve) => {
              finishSave = () => resolve({ ...board, revision: 2 });
            });
          },
        },
      },
    });
    const session = fixture.root.sessionRegistry.load("background", "/project");
    session.showPresentation("draw");
    session.drawStore.attachEditor(editor());
    await session.drawStore.initialize();
    const response = fixture.root.drawControlStore.invoke("background", {
      _tag: "Apply",
      operations: [
        { type: "create", shape: { id: "agent", type: "geo", x: 0, y: 0, width: 100, height: 80 } },
      ],
    });
    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await started;
    expect(settled).toBe(false);
    finishSave();
    await expect(response).resolves.toMatchObject({
      ok: true,
      kind: "applied",
      checkpointId: expect.any(String),
    });
  });

  it("rejects resolved sessions, allows restored sessions, and registers newly loaded identities", async () => {
    using fixture = createRendererStoreFixture({
      sessions: [
        sessionSummary({ sessionId: "background", projectPath: "/project", resolved: true }),
      ],
    });
    const controls = fixture.root.drawControlStore;
    expect(await controls.invoke("background", { _tag: "Read", scope: "page" })).toMatchObject({
      code: "DRAW_MODE_REQUIRED",
    });
    fixture.root.sessionRegistry.load("background", "/project");
    expect(await controls.invoke("background", { _tag: "Read", scope: "page" })).toMatchObject({
      code: "SESSION_RESOLVED",
    });
    fixture.models.sessionCatalog.find("background")!.resolved = false;
    expect(await controls.invoke("background", { _tag: "Read", scope: "page" })).toMatchObject({
      code: "DRAW_MODE_REQUIRED",
    });
    fixture.root.sessionRegistry.removeSession("background");
    expect(await controls.invoke("background", { _tag: "Read", scope: "page" })).toMatchObject({
      code: "DRAW_MODE_REQUIRED",
    });
  });
});
