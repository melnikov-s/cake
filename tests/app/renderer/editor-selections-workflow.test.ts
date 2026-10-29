import { toSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorLocation } from "../../../src/contracts/editor/editor-location";
import type {
  EditorSelectionHighlights,
  EditorSelectionReveal,
} from "../../../src/contracts/editor/editor-selection";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createSelectionCommandFixture } from "./editor-selection-ui-workflow-fixture";

const workspace = "/projects/example";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness() {
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
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: workspace, name: "Example" })],
    sessions: ["a", "b"].map((sessionId) => sessionSummary({ sessionId, projectPath: workspace })),
    client: {
      filesystem: { prepareFileLocation: async ({ location }) => ({ viewer: "vscode", location }) },
      vscode: {
        open: vi.fn(async () => undefined),
        reveal,
        updateSelectionHighlights,
        updateBounds: vi.fn(async () => undefined),
        updateAnnotations: vi.fn(async () => undefined),
      },
    },
  });
  const { root } = fixture;
  const a = root.sessionRegistry.load("a", workspace);
  const b = root.sessionRegistry.load("b", workspace);
  const editor = root.projectWorkbenchStore.presentationStore.embeddedEditorStore;
  const select = (sessionId: string) => {
    root.navigationStore.selectProjectSession(sessionId);
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
  cleanups.push(() => fixture[Symbol.dispose]());
  return { root, a, b, editor, select, invoke, enter, open, reveal, updateSelectionHighlights };
}

// Real Root composition, application-control bridge, source routing and Stores;
// only the native Client boundary is replaced.
function gate<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}

// Consolidated command/native exceptions, not claimed as React migrations:
// normalized native replies, caller-owned results, queued commands, disposal
// and persistence. The Root and public application-control operations are real;
// only external Clients are faked. Visible reveal/dismiss/retry, cross-session
// pills and hidden-editor removal/reopen are covered by editor-selection-ui-workflow.
// Actual native selection/navigation remains Electron coverage, not this suite.
describe("Editor selection command-boundary integration", () => {
  it("reuses an ID when native ranges differ only by omitted zero columns", async () => {
    using fixture = await createSelectionCommandFixture();
    const first = await fixture.open();
    fixture.reveal.mockResolvedValueOnce({
      outcome: { view: "file" },
      locations: [
        {
          kind: "working-directory",
          path: "src/tour.ts",
          view: "file",
          range: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 } },
        },
      ],
    });
    const second = await fixture.open();
    expect(second.selectionIds).toEqual(first.selectionIds);
    expect(first.selectionIds).toHaveLength(1);
    expect((await fixture.list()).selections).toHaveLength(1);
  });

  it("keeps overlapping ranges and distinct diff sides or bases in insertion order", async () => {
    using fixture = await createSelectionCommandFixture();
    await fixture.open({ path: "src/tour.ts", line: 2 });
    await fixture.open({ path: "src/tour.ts", line: 2, endLine: 5 });
    for (const [side, base] of [
      ["before", "HEAD"],
      ["after", "HEAD"],
      ["before", "main"],
    ] as const) {
      fixture.reveal.mockResolvedValueOnce({
        outcome: { view: "changes" },
        locations: [
          {
            kind: "working-directory",
            view: "changes",
            path: "src/tour.ts",
            side,
            base,
            range: { start: { line: 1 } },
          },
        ],
      });
      await fixture.open({ path: "src/tour.ts", line: 2, view: "changes", side, base });
    }
    const { selections } = await fixture.list();
    expect(new Set(selections.map((selection) => selection.id)).size).toBe(5);
    expect(selections.map(({ location }) => location)).toEqual([
      expect.objectContaining({ view: "file", range: { start: { line: 1 }, end: { line: 1 } } }),
      expect.objectContaining({ view: "file", range: { start: { line: 1 }, end: { line: 4 } } }),
      expect.objectContaining({ view: "changes", side: "before", base: "HEAD" }),
      expect.objectContaining({ view: "changes", side: "after", base: "HEAD" }),
      expect.objectContaining({ view: "changes", side: "before", base: "main" }),
    ]);
  });

  it("treats removal of an unknown ID and clearing an empty collection as idempotent commands", async () => {
    using fixture = await createSelectionCommandFixture();
    expect(await fixture.invoke("vscode.selections.remove", { id: "unknown" })).toMatchObject({
      ok: true,
      update: { state: { selections: [] } },
    });
    expect(await fixture.invoke("vscode.selections.clear")).toMatchObject({
      ok: true,
      update: { state: { selections: [] } },
    });
    expect((await fixture.list()).selections).toEqual([]);
  });

  it("returns detached command replies that callers cannot use to mutate authoritative selections", async () => {
    using fixture = await createSelectionCommandFixture();
    await fixture.open();
    const copy = await fixture.list();
    Reflect.set(copy.selections[0]!.location.range.start, "line", 99);
    Array.prototype.pop.call(copy.selections);
    expect((await fixture.list()).selections).toEqual([
      expect.objectContaining({
        location: expect.objectContaining({ range: { start: { line: 1 }, end: { line: 2 } } }),
      }),
    ]);
  });

  // A stale ID has no remaining React control and no public reveal-by-ID tool.
  // Retain this narrow native-boundary regression with the real Root session;
  // do not fabricate a stale click/callback to claim an honest UI replacement.
  it("rejects a stale reveal ID after clearing and reopening the same location", async () => {
    using fixture = await createSelectionCommandFixture();
    const first = await fixture.open();
    await fixture.invoke("vscode.selections.clear");
    const replacement = await fixture.open();
    expect(replacement.selectionIds[0]).not.toBe(first.selectionIds[0]);
    const reveals = fixture.reveal.mock.calls.length;
    const session = fixture.root.sessionRegistry.findSession("tour-session");
    if (!session) throw new Error("Missing Root session");
    await expect(session.editorSelectionsStore.reveal(first.selectionIds[0]!)).rejects.toThrow(
      "Unknown selection",
    );
    expect(fixture.reveal).toHaveBeenCalledTimes(reveals);
    expect((await fixture.list()).selections.map(({ id }) => id)).toEqual(replacement.selectionIds);
  });

  it("rejects failed native opening before registration and permits a fresh open", async () => {
    using fixture = await createSelectionCommandFixture();
    fixture.reveal.mockRejectedValueOnce(new Error("Native unavailable"));
    await expect(fixture.open()).rejects.toThrow("Native unavailable");
    expect((await fixture.list()).selections).toEqual([]);
    await fixture.open();
    expect((await fixture.list()).selections).toHaveLength(1);
  });

  it("serializes open, remove and clear so pending native completion cannot undo a later clear", async () => {
    using fixture = await createSelectionCommandFixture();
    const entered = gate<void>();
    const native = gate<EditorSelectionReveal>();
    fixture.reveal.mockImplementationOnce(() => {
      entered.resolve();
      return native.promise;
    });
    const opening = fixture.open();
    await entered.promise;
    const removing = fixture.invoke("vscode.selections.remove", { id: "missing" });
    const clearing = fixture.invoke("vscode.selections.clear");
    native.resolve({
      outcome: { view: "file" },
      locations: [
        {
          kind: "working-directory",
          view: "file",
          path: "src/tour.ts",
          range: { start: { line: 1 } },
        },
      ],
    });
    expect((await opening).selectionIds).toHaveLength(1);
    expect(await removing).toMatchObject({
      update: { state: { selections: [expect.any(Object)] } },
    });
    expect(await clearing).toMatchObject({ update: { state: { selections: [] } } });
    expect((await fixture.list()).selections).toEqual([]);
    expect(fixture.highlights).toHaveBeenLastCalledWith(
      "/project",
      { locations: [] },
      expect.any(Object),
    );
  });

  it("rejects late native completion after renderer disposal and recreates empty selection authority", async () => {
    const fixture = await createSelectionCommandFixture();
    const entered = gate<void>();
    const native = gate<EditorSelectionReveal>();
    fixture.reveal.mockImplementationOnce(() => {
      entered.resolve();
      return native.promise;
    });
    const pending = fixture.open();
    await entered.promise;
    fixture[Symbol.dispose]();
    expect(fixture.reveal.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    native.resolve({
      outcome: { view: "file" },
      locations: [
        {
          kind: "working-directory",
          view: "file",
          path: "src/tour.ts",
          range: { start: { line: 1 } },
        },
      ],
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    using next = await createSelectionCommandFixture();
    expect((await next.list()).selections).toEqual([]);
  });

  it("keeps selection locations out of persisted window snapshots", async () => {
    using fixture = await createSelectionCommandFixture();
    await fixture.open({ path: "src/ephemeral-tour-only.ts", line: 2 });
    expect((await fixture.list()).selections).toHaveLength(1);
    expect(JSON.stringify(toSnapshot(fixture.root))).not.toContain("ephemeral-tour-only.ts");
  });
});

// These source-routing and active-session races enter through real renderer
// operations over native Clients. Visible reveal/dismiss/session restoration
// behavior is consolidated in editor-selection-ui-workflow.test.tsx.
describe("session-owned VS Code selection workflow", () => {
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
