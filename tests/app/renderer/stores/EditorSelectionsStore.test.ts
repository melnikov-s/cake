import { toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { EditorSelectionReveal } from "../../../../src/contracts/editor/editor-selection";
import { createSelectionCommandFixture } from "../editor-selection-ui-workflow-fixture";

function gate<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}

// Retain command/native-boundary contracts that cannot be triggered honestly
// by React alone: normalized native results, caller-owned replies, queued
// commands, disposal and persistence. These use real Root composition and
// public application-control operations with typed native Client fakes, not
// mocked Store collaborators. UI reveal/dismissal/recovery and composer
// independence live in editor-selection-ui-workflow.test.tsx; cross-session,
// source routing and hidden-editor behavior live in editor-selections-workflow.
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
