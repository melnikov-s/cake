import { applySnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { DrawBoardMetadata } from "../../../../src/contracts/draw/draw-board-data";
import type { DrawDocumentSnapshot, DrawScene } from "../../../../src/contracts/draw/draw-editor";
import type { Client } from "../../../../src/renderer/client/Client";
import type { DrawEditorAdapter } from "../../../../src/renderer/draw/DrawEditorAdapter";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";

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
const receipt = { createdIds: [], updatedIds: [], deletedIds: [] };
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is the drawing-domain entity in the DrawScene contract. */
const scene: DrawScene = {
  pageId: "page:default",
  viewportBounds: { x: 0, y: 0, width: 800, height: 600 },
  selectedShapeIds: [],
  shapes: [],
  truncated: false,
};
/* oxlint-enable anti-slop/no-shape-in-symbol-names */

// Controlled native-editor boundary for an empty document and a no-op selection.
// No shape creation, geometry, rendering or playback is simulated or asserted.
function emptyEditor(): DrawEditorAdapter {
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Agent-issued Draw commands are an external transport, not accessible GUI actions.
// Keep real Root/Registry/Draw/Models and typed persistence fakes. App opening,
// loading/retry and default-board GUI paths already live in draw-workflow.test.tsx.
// Canvas edits, exports, geometry and native undo remain in DrawEditorAdapter tests
// and tests/electron/draw*.spec.ts; mounting a fake canvas here would not replace them.
// Unlike RootStore's registered callback test, these exercise the real loaded-session
// handler, including authoritative resolution and removal/re-registration.
describe("Draw control transport integration", () => {
  it("routes restored and reloaded background sessions without changing the focused presentation", async () => {
    const focusedSummary = sessionSummary({ sessionId: "focused", projectPath: "/project" });
    const backgroundSummary = sessionSummary({
      sessionId: "background",
      projectPath: "/project",
      resolved: true,
    });
    const list: Client["draw"]["list"] = async () => [board];
    const read: Client["draw"]["read"] = async () => ({ board, snapshot: document });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [focusedSummary, backgroundSummary],
      client: { draw: { list, read } },
    });
    const controls = fixture.root.drawControlStore;
    expect(await controls.invoke("background", { _tag: "Enter" })).toMatchObject({
      ok: false,
      code: "DRAW_MODE_REQUIRED",
    });

    const focused = fixture.root.sessionRegistry.load("focused", "/project");
    const background = fixture.root.sessionRegistry.load("background", "/project");
    background.drawStore.attachEditor(emptyEditor());
    fixture.root.appShellStore.selectProjectSession("focused");
    fixture.root.projectWorkbenchStore.showLoadedSession("focused");
    fixture.root.sessionLayoutStore.ensureSession("focused");
    expect(await controls.invoke("background", { _tag: "Enter" })).toMatchObject({
      ok: false,
      code: "SESSION_RESOLVED",
    });
    expect(background.presentationMode).toBe("normal");

    // Main-owned catalog restoration arrives through the real projection Model.
    applySnapshot(fixture.models.sessionCatalog, {
      sessions: [focusedSummary, { ...backgroundSummary, resolved: false }],
      resolvedHasMoreByProject: {},
    });
    expect(await controls.invoke("background", { _tag: "Enter" })).toEqual({
      ok: true,
      kind: "entered",
      board,
      scene,
    });
    expect(background.presentationMode).toBe("draw");
    expect(focused.presentationMode).toBe("normal");
    expect(fixture.root.projectWorkbenchStore.activeSessionId).toBe("focused");
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "project-session",
      sessionId: "focused",
    });
    expect(fixture.root.sessionLayoutStore.focusedSessionId).toBe("focused");

    fixture.root.sessionRegistry.removeSession("background");
    expect(await controls.invoke("background", { _tag: "Read", scope: "page" })).toMatchObject({
      ok: false,
      code: "DRAW_MODE_REQUIRED",
    });
    const reloaded = fixture.root.sessionRegistry.load("background", "/project");
    reloaded.drawStore.attachEditor(emptyEditor());
    expect(await controls.invoke("background", { _tag: "Enter" })).toEqual({
      ok: true,
      kind: "entered",
      board,
      scene,
    });
    expect(await controls.invoke("background", { _tag: "Read", scope: "page" })).toEqual({
      ok: true,
      kind: "read",
      boardId: board.id,
      scene,
    });
    expect(fixture.root.projectWorkbenchStore.activeSessionId).toBe("focused");
    expect(fixture.root.sessionLayoutStore.focusedSessionId).toBe("focused");
  });

  it("acknowledges an Apply checkpoint only after persistence commits its board revision", async () => {
    const started = deferred();
    const finishSave = deferred();
    let authorityBoard = board;
    let persisted: DrawDocumentSnapshot = document;
    let requestedSave: Parameters<Client["draw"]["save"]>[0] | undefined;
    const save: Client["draw"]["save"] = async (input) => {
      requestedSave = input;
      started.resolve();
      await finishSave.promise;
      persisted = input.snapshot;
      authorityBoard = { ...authorityBoard, revision: authorityBoard.revision + 1 };
      return authorityBoard;
    };
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "background", projectPath: "/project" })],
      client: {
        draw: {
          list: async () => [authorityBoard],
          read: async () => ({ board: authorityBoard, snapshot: persisted }),
          save,
        },
      },
    });
    const session = fixture.root.sessionRegistry.load("background", "/project");
    session.drawStore.attachEditor(emptyEditor());
    await fixture.root.drawControlStore.invoke("background", { _tag: "Enter" });

    const response = fixture.root.drawControlStore.invoke("background", {
      _tag: "Apply",
      // Exercise transport/checkpoint persistence without inventing a native edit.
      operations: [{ type: "select", ids: [] }],
    });
    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await started.promise;
    expect(settled).toBe(false);
    expect(authorityBoard.revision).toBe(1);
    expect(requestedSave).toEqual({
      sessionId: "background",
      boardId: board.id,
      expectedRevision: 1,
      snapshot: document,
    });

    finishSave.resolve();
    const result = await response;
    expect(result).toEqual({
      ok: true,
      kind: "applied",
      boardId: board.id,
      checkpointId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      receipt,
      scene,
    });
    expect(authorityBoard.revision).toBe(2);
    expect(session.drawStore.activeBoard).toEqual(authorityBoard);
    expect(persisted).toEqual(document);
  });
});
