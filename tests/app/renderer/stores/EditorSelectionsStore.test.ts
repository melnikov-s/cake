import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { EditorLocation } from "../../../../src/ipc/editor-location";
import {
  EditorSelectionId,
  type EditorSelectionLocation,
} from "../../../../src/ipc/editor-selection";
import { EditorSelectionsStore } from "../../../../src/renderer/stores/EditorSelectionsStore";

const range = (line: number) => ({ start: { line }, end: { line, column: 2 } });
const file = (path: string, line: number): EditorSelectionLocation => ({
  kind: "working-directory",
  view: "file",
  path,
  range: range(line),
});
function fixture(
  openLocation = vi.fn(async (location: EditorLocation) => ({
    outcome: { view: "file" as const },
    locations: location.range ? [file(location.path, location.range.start.line)] : [],
  })),
) {
  const refreshHighlights = vi.fn(async () => {});
  const store = mount(
    createStore(EditorSelectionsStore, {
      sessionId: "session-one",
      openLocation,
      refreshHighlights,
    }),
  );
  return {
    store,
    openLocation,
    refreshHighlights,
    [Symbol.dispose]() {
      store[Symbol.dispose]();
    },
  };
}
const request = (path: string, line: number): EditorLocation => ({
  kind: "working-directory",
  path,
  range: range(line),
});

describe("EditorSelectionsStore", () => {
  it("accumulates distinct ranges within one file and across files in insertion order", async () => {
    using f = fixture();
    await f.store.open(request("a.ts", 1));
    await f.store.open(request("a.ts", 3));
    await f.store.open(request("b.ts", 2));
    expect(
      f.store.list().selections.map(({ location }) => [location.path, location.range.start.line]),
    ).toEqual([
      ["a.ts", 1],
      ["a.ts", 3],
      ["b.ts", 2],
    ]);
    expect(f.refreshHighlights).toHaveBeenCalledTimes(3);
  });
  it("allocates IDs in the Store and reuses an ID for an exact normalized duplicate", async () => {
    using f = fixture();
    const first = await f.store.open(request("a.ts", 1));
    const second = await f.store.open(request("a.ts", 1));
    expect(first.selectionIds).toEqual(second.selectionIds);
    expect(f.store.selections).toHaveLength(1);
    expect(first.selectionIds[0]).toBeTruthy();
    expect(f.store.list().sessionId).toBe("session-one");
  });
  it("keeps overlapping ranges and different diff sides or bases as distinct selections", async () => {
    const locations: EditorSelectionLocation[] = [
      file("a.ts", 1),
      { ...file("a.ts", 1), range: { start: { line: 1 }, end: { line: 4 } } },
      {
        kind: "working-directory",
        view: "changes",
        path: "a.ts",
        range: range(1),
        side: "before",
        base: "HEAD",
      },
      {
        kind: "working-directory",
        view: "changes",
        path: "a.ts",
        range: range(1),
        side: "after",
        base: "HEAD",
      },
      {
        kind: "working-directory",
        view: "changes",
        path: "a.ts",
        range: range(1),
        side: "before",
        base: "main",
      },
    ];
    using f = fixture(vi.fn(async () => ({ outcome: { view: "file" as const }, locations })));
    const result = await f.store.open(request("a.ts", 1));
    expect(new Set(result.selectionIds).size).toBe(5);
  });
  it("removes only the requested ID and preserves every other selection", async () => {
    using f = fixture();
    const a = (await f.store.open(request("a.ts", 1))).selectionIds[0]!;
    const b = (await f.store.open(request("b.ts", 2))).selectionIds[0]!;
    expect((await f.store.remove(a)).state.selections.map(({ id }) => id)).toEqual([b]);
    expect(f.refreshHighlights).toHaveBeenCalledTimes(3);
  });
  it("treats unknown removal and clearing an empty collection as no-ops", async () => {
    using f = fixture();
    expect((await f.store.remove(EditorSelectionId.make("unknown"))).state.selections).toEqual([]);
    expect((await f.store.clear()).state.selections).toEqual([]);
    expect(f.refreshHighlights).not.toHaveBeenCalled();
  });
  it("clears all selections and gives a subsequently opened location a new ID", async () => {
    using f = fixture();
    const id = (await f.store.open(request("a.ts", 1))).selectionIds[0];
    await f.store.open(request("b.ts", 2));
    expect((await f.store.clear()).state.selections).toEqual([]);
    expect((await f.store.open(request("a.ts", 1))).selectionIds[0]).not.toBe(id);
  });
  it("returns a detached list so tool callers cannot mutate the Store's collection", async () => {
    using f = fixture();
    await f.store.open(request("a.ts", 1));
    const copy = f.store.list();
    (copy.selections[0]!.location.range.start as { line: number }).line = 99;
    (copy.selections as unknown as unknown[]).pop();
    expect(f.store.selections[0]?.location.range.start.line).toBe(1);
    expect(f.store.selections).toHaveLength(1);
  });
  it("leaves selections unchanged when native opening fails before registration", async () => {
    using f = fixture(
      vi.fn(async () => {
        throw new Error("native unavailable");
      }),
    );
    await expect(f.store.open(request("a.ts", 1))).rejects.toThrow("native unavailable");
    expect(f.store.selections).toEqual([]);
    expect(f.store.error).toContain("native unavailable");
    expect(f.refreshHighlights).not.toHaveBeenCalled();
  });
  it("keeps removal effective and reports a warning when highlight rendering fails", async () => {
    using f = fixture();
    const id = (await f.store.open(request("a.ts", 1))).selectionIds[0]!;
    f.refreshHighlights.mockRejectedValueOnce(new Error("editor closed"));
    const update = await f.store.remove(id);
    expect(update.state.selections).toEqual([]);
    expect(update.warning).toContain("editor closed");
    expect(f.store.error).toContain("editor closed");
  });
  it("serializes open, remove, and clear so a pending open cannot undo a later clear", async () => {
    let resolve!: (value: {
      outcome: { view: "file" };
      locations: EditorSelectionLocation[];
    }) => void;
    using f = fixture(
      vi.fn(
        () =>
          new Promise<{ outcome: { view: "file" }; locations: EditorSelectionLocation[] }>(
            (done) => {
              resolve = done;
            },
          ),
      ),
    );
    const opening = f.store.open(request("a.ts", 1));
    const removing = f.store.remove(EditorSelectionId.make("missing"));
    const clearing = f.store.clear();
    await Promise.resolve();
    resolve({ outcome: { view: "file" }, locations: [file("a.ts", 1)] });
    expect((await opening).selectionIds).toHaveLength(1);
    expect((await removing).state.selections).toHaveLength(1);
    expect((await clearing).state.selections).toEqual([]);
  });
  it("rejects reveal of a removed ID without recreating it", async () => {
    using f = fixture();
    const id = (await f.store.open(request("a.ts", 1))).selectionIds[0]!;
    await f.store.reveal(id);
    expect(f.openLocation).toHaveBeenCalledTimes(2);
    await f.store.remove(id);
    await expect(f.store.reveal(id)).rejects.toThrow("Unknown selection");
    expect(f.openLocation).toHaveBeenCalledTimes(2);
  });
  it("reports native reveal errors to the pill without changing selections", async () => {
    using f = fixture();
    const id = (await f.store.open(request("a.ts", 1))).selectionIds[0]!;
    f.openLocation.mockRejectedValueOnce(new Error("file missing"));
    await expect(f.store.reveal(id)).rejects.toThrow("file missing");
    expect(f.store.error).toContain("file missing");
    expect(f.store.selections.map(({ id: selectedId }) => selectedId)).toEqual([id]);
    await f.store.reveal(id);
    expect(f.store.error).toBeUndefined();
  });
  it("ignores late native results after disposal and starts a recreated Store empty", async () => {
    let resolve!: (value: {
      outcome: { view: "file" };
      locations: EditorSelectionLocation[];
    }) => void;
    const f = fixture(
      vi.fn(
        () =>
          new Promise<{ outcome: { view: "file" }; locations: EditorSelectionLocation[] }>(
            (done) => {
              resolve = done;
            },
          ),
      ),
    );
    const pending = f.store.open(request("a.ts", 1));
    await Promise.resolve();
    f.store[Symbol.dispose]();
    resolve({ outcome: { view: "file" }, locations: [file("a.ts", 1)] });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.store.selections).toEqual([]);
    using next = fixture();
    expect(next.store.list().selections).toEqual([]);
  });
  it("keeps selections out of persisted Store snapshots", async () => {
    using f = fixture();
    await f.store.open(request("a.ts", 1));
    expect(JSON.stringify(toSnapshot(f.store))).not.toContain("a.ts");
  });
  it("keeps tour selections when the composer sends a message or clears attachments", async () => {
    using f = fixture();
    const id = (await f.store.open(request("a.ts", 1))).selectionIds[0];
    // Composer actions do not touch this session-owned Store; only its own commands mutate it.
    const sendMessage = vi.fn();
    const clearAttachments = vi.fn();
    sendMessage();
    clearAttachments();
    expect(f.store.list().selections.map(({ id }) => id)).toEqual([id]);
    expect(f.refreshHighlights).toHaveBeenCalledTimes(1);
  });
});
