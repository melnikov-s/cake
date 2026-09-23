import { applySnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorLocation } from "../../../src/ipc/editor-location";
import type {
  EditorSelectionHighlights,
  EditorSelectionReveal,
} from "../../../src/ipc/editor-selection";
import type { JsonObject } from "../../../src/ipc/json-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { mountRootStore } from "../../../src/renderer/bootstrap/mount-root-store";
import { RootProjection } from "../../../src/renderer/models/RootProjection";

const workspace = "/projects/example";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness() {
  const models = RootProjection.create();
  applySnapshot(models.sessionCatalog, {
    sessions: ["a", "b"].map((sessionId) => ({
      sessionId,
      title: sessionId,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      resolved: false,
      unread: false,
      projectPath: workspace,
      projectName: "Example",
      workingDirectory: workspace,
      pending: false,
      draft: false,
    })),
    resolvedHasMoreByProject: {},
  });
  const reveal = vi.fn(
    async (_workspace: string, location: EditorLocation): Promise<EditorSelectionReveal> => ({
      outcome: { view: "file" },
      locations: (location.ranges ?? (location.range ? [location.range] : [])).map((range) => ({
        kind: location.kind,
        path: location.path,
        view: "file",
        range,
      })),
    }),
  );
  const updateSelectionHighlights = vi.fn(
    async (_workspace: string, _highlights: EditorSelectionHighlights) => {
      void [_workspace, _highlights];
    },
  );
  const client = {
    vscode: {
      open: vi.fn(async () => undefined),
      reveal,
      updateSelectionHighlights,
      updateBounds: vi.fn(async () => undefined),
      updateAnnotations: vi.fn(async () => undefined),
    },
  } as unknown as Client;
  const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);
  const a = root.sessionRegistry.load("a", workspace);
  const b = root.sessionRegistry.load("b", workspace);
  const editor = root.projectWorkbenchStore.presentationStore.embeddedEditorStore;
  const select = (sessionId: string) => {
    root.appShellStore.selectProjectSession(sessionId);
    root.projectWorkbenchStore.showLoadedSession(sessionId);
  };
  select("a");
  const invoke = (name: string, args: JsonObject = {}, sessionId = "a") =>
    root.applicationControlStore.invoke(
      { name, arguments: args },
      {
        kind: "project-session",
        sessionId,
        title: sessionId,
        projectName: "Example",
        projectPath: workspace,
        workingDirectory: workspace,
      },
    );
  const enter = async (sessionId = "a") => {
    expect(await invoke("vscode.enter", {}, sessionId)).toMatchObject({ ok: true });
  };
  const open = async (path = "src/a.ts", line = 2, sessionId = "a") => {
    const result = await invoke("vscode.open", { path, line, endLine: line + 1 }, sessionId);
    expect(result).toMatchObject({ ok: true });
    return result;
  };
  cleanups.push(() => {
    root[Symbol.dispose]();
    models[Symbol.dispose]();
  });
  return { root, a, b, editor, select, invoke, enter, open, reveal, updateSelectionHighlights };
}

// Real Root composition, application-control bridge, source routing and Stores;
// only the native Client boundary is replaced.
describe("session-owned VS Code selection workflow", () => {
  it("routes agent ranged opens through the source session's Store into the pill collection", async () => {
    const h = harness();
    await h.enter();
    const reply = await h.open();
    expect(h.a.editorSelectionsStore.selections).toHaveLength(1);
    expect(reply).toMatchObject({
      selection: { selectionIds: [h.a.editorSelectionsStore.selections[0]!.id] },
    });
  });
  it("does not create a tour selection for a file-only open or a manual text selection", async () => {
    const h = harness();
    await h.enter();
    await h.invoke("vscode.open", { path: "src/a.ts" });
    h.editor.receive({
      type: "embedded-editor-selection",
      workspacePath: workspace,
      path: "src/a.ts",
      startLine: 0,
      endLine: 2,
    });
    expect(h.a.editorSelectionsStore.selections).toEqual([]);
  });
  it("fans out a disjoint source-link reveal into independently removable selections", async () => {
    const h = harness();
    await h.root.projectWorkbenchStore.presentationStore.openFile({
      kind: "working-directory",
      path: "src/a.ts",
      ranges: [{ start: { line: 1 } }, { start: { line: 8 } }],
    });
    const [first, second] = h.a.editorSelectionsStore.selections;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    await h.a.editorSelectionsStore.remove(first!.id);
    expect(h.a.editorSelectionsStore.selections).toEqual([second]);
  });
  it("does not route a source link into the new session when Draw flush finishes after a switch", async () => {
    const h = harness();
    h.a.showPresentation("draw");
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => (started = resolve));
    vi.spyOn(h.a.drawStore, "flush").mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => (release = resolve));
    });
    const opening = h.root.projectWorkbenchStore.presentationStore.openFile({
      kind: "working-directory",
      path: "src/a.ts",
      range: { start: { line: 1 } },
    });
    await began;
    h.select("b");
    release();
    await opening;
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.a.editorSelectionsStore.selections).toEqual([]);
    expect(h.b.editorSelectionsStore.selections).toEqual([]);
  });
  it("does not register a stale selection when native reveal finishes after a session switch", async () => {
    const h = harness();
    await h.enter();
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => (started = resolve));
    h.reveal.mockImplementationOnce(async (_workspace, location) => {
      started();
      await new Promise<void>((resolve) => (release = resolve));
      return {
        outcome: { view: "file" },
        locations: [
          {
            kind: location.kind,
            path: location.path,
            view: "file",
            range: location.range!,
          },
        ],
      };
    });
    const opening = h.invoke("vscode.open", { path: "src/a.ts", line: 2 });
    await began;
    h.select("b");
    release();
    await expect(opening).rejects.toThrow("active session changed");
    expect(h.a.editorSelectionsStore.selections).toEqual([]);
    expect(h.b.editorSelectionsStore.selections).toEqual([]);
  });
  it("records resolved clamped ranges and the actual file view after a diff fallback", async () => {
    const h = harness();
    await h.enter();
    const resolved = {
      kind: "working-directory" as const,
      path: "src/a.ts",
      view: "file" as const,
      range: { start: { line: 3, column: 0 }, end: { line: 3, column: 5 } },
    };
    h.reveal.mockResolvedValueOnce({
      outcome: { view: "file", fallback: "no-changes" },
      locations: [resolved],
    });
    await h.invoke("vscode.open", { path: "src/a.ts", line: 999, view: "changes" });
    expect(h.a.editorSelectionsStore.selections[0]?.location).toEqual(resolved);
  });
  it("isolates two session Stores even when their sessions share a Working Directory", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    h.select("b");
    await h.enter("b");
    await h.open("src/b.ts", 7, "b");
    expect(h.a.editorSelectionsStore).not.toBe(h.b.editorSelectionsStore);
    expect(h.a.editorSelectionsStore.selections[0]?.location.path).toBe("src/a.ts");
    expect(h.b.editorSelectionsStore.selections[0]?.location.path).toBe("src/b.ts");
  });
  it("routes list, remove, and clear to the calling session rather than the focused session", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    await h.open("src/a.ts", 8);
    const id = h.a.editorSelectionsStore.selections[0]!.id;
    h.select("b");
    await h.enter("b");
    await h.open("src/b.ts", 3, "b");
    expect(await h.invoke("vscode.selections.list")).toMatchObject({
      state: { sessionId: "a", selections: [{ id }, expect.any(Object)] },
    });
    await h.invoke("vscode.selections.remove", { id });
    await h.invoke("vscode.selections.clear");
    expect(h.a.editorSelectionsStore.selections).toEqual([]);
    expect(h.b.editorSelectionsStore.selections).toHaveLength(1);
    expect(h.updateSelectionHighlights).toHaveBeenLastCalledWith(
      workspace,
      { locations: h.b.editorSelectionsStore.selections.map((s) => s.location) },
      expect.any(Object),
    );
  });
  it("reports an unavailable owning renderer instead of creating selection state in main", async () => {
    const h = harness();
    await expect(h.invoke("vscode.selections.list", {}, "missing")).rejects.toThrow("unavailable");
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.root.sessionRegistry.findSession("missing")).toBeUndefined();
  });
  it("navigates a pill by ID without duplicating it or clearing another selection", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    await h.open("src/b.ts", 6);
    const before = h.a.editorSelectionsStore.list();
    await h.a.editorSelectionsStore.reveal(before.selections[0]!.id);
    expect(h.reveal).toHaveBeenLastCalledWith(
      workspace,
      {
        kind: "working-directory",
        path: "src/a.ts",
        range: { start: { line: 1 }, end: { line: 2 } },
      },
      expect.any(Object),
    );
    expect(h.a.editorSelectionsStore.list()).toEqual(before);
  });
  it("uses the same Store mutation for user dismissal and agent removal", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    await h.open("src/b.ts", 6);
    const ids = h.a.editorSelectionsStore.selections.map((s) => s.id);
    await h.a.editorSelectionsStore.remove(ids[0]!);
    await h.invoke("vscode.selections.remove", { id: ids[1]! });
    expect(h.a.editorSelectionsStore.selections).toEqual([]);
    expect(h.updateSelectionHighlights).toHaveBeenLastCalledWith(
      workspace,
      { locations: [] },
      expect.any(Object),
    );
  });
  it("sends only highlight locations to the native bridge while keeping IDs in Store and agent replies", async () => {
    const h = harness();
    await h.enter();
    const reply = await h.open();
    const selection = h.a.editorSelectionsStore.selections[0]!;
    expect(h.updateSelectionHighlights).toHaveBeenLastCalledWith(
      workspace,
      { locations: [selection.location] },
      expect.any(Object),
    );
    expect(reply).toMatchObject({ selection: { selectionIds: [selection.id] } });
    expect(JSON.stringify(h.updateSelectionHighlights.mock.calls)).not.toContain(selection.id);
  });
  it("allows list, removal, and clear while VS Code is hidden", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    await h.open("src/b.ts", 8);
    h.editor.hide();
    const sends = h.updateSelectionHighlights.mock.calls.length;
    const id = h.a.editorSelectionsStore.selections[0]!.id;
    expect(await h.invoke("vscode.selections.list")).toMatchObject({ ok: true });
    await h.invoke("vscode.selections.remove", { id });
    await h.invoke("vscode.selections.clear");
    expect(h.a.editorSelectionsStore.selections).toEqual([]);
    expect(h.updateSelectionHighlights).toHaveBeenCalledTimes(sends);
  });
  it("restores a retained session's pills and highlights after switching away and back", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    const selections = h.a.editorSelectionsStore.list();
    h.select("b");
    await h.enter("b");
    await h.open("src/b.ts", 8, "b");
    h.select("a");
    await h.editor.open();
    await h.editor.syncSelectionHighlights();
    expect(h.a.editorSelectionsStore.list()).toEqual(selections);
    expect(h.updateSelectionHighlights).toHaveBeenLastCalledWith(
      workspace,
      { locations: selections.selections.map((s) => s.location) },
      expect.any(Object),
    );
  });
  it("renders an empty session's selection list when switching from a populated session", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    h.select("b");
    await h.enter("b");
    expect(h.updateSelectionHighlights).toHaveBeenLastCalledWith(
      workspace,
      { locations: [] },
      expect.any(Object),
    );
  });
  it("resends current highlight locations on editor reopen including removals made while hidden", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    h.editor.hide();
    await h.invoke("vscode.selections.clear");
    await h.enter();
    expect(h.updateSelectionHighlights).toHaveBeenLastCalledWith(
      workspace,
      { locations: [] },
      expect.any(Object),
    );
  });
  it("prevents an old session's delayed rendering from overwriting the active session's highlights", async () => {
    const h = harness();
    await h.enter();
    await h.open();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.updateSelectionHighlights.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const oldSend = h.editor.syncSelectionHighlights();
    await startedPromise;
    h.select("b");
    const entering = h.enter("b");
    release();
    await oldSend;
    await entering;
    await h.editor.syncSelectionHighlights();
    expect(h.updateSelectionHighlights).toHaveBeenLastCalledWith(
      workspace,
      { locations: [] },
      expect.any(Object),
    );
  });
  it("does not let a background ranged open navigate the active session's shared editor", async () => {
    const h = harness();
    await h.enter();
    h.select("b");
    await h.enter("b");
    await expect(h.invoke("vscode.open", { path: "src/a.ts", line: 2 })).rejects.toThrow(
      "VSCODE_MODE_REQUIRED",
    );
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.a.editorSelectionsStore.selections).toEqual([]);
  });
});
