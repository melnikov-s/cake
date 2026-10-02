import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionLayoutStore } from "../../../../src/renderer/stores/SessionLayoutStore";

// Migration backlog: family-driven pane reuse, staged-history restoration and
// persisted resize geometry are not exercised by the click-only App workflow.
// Split/close, visible pane numbers, navigation, pane reuse and limits moved to
// session-layout-workflow.test.tsx.
describe("SessionLayoutStore remaining contracts", () => {
  it("reuses one adjacent pane for sequential family children", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("parent");

    const firstPaneId = store.showChildSession("parent", "child-1");
    expect(store.panes.map((pane) => pane.sessionId)).toEqual(["parent", "child-1"]);
    expect(store.neighbors("parent").right).toEqual([
      { paneId: firstPaneId, sessionId: "child-1" },
    ]);

    const secondPaneId = store.showChildSession("parent", "child-2");
    expect(secondPaneId).toBe(firstPaneId);
    expect(store.panes.map((pane) => pane.sessionId)).toEqual(["parent", "child-2"]);
    expect(store.hasSession("child-1")).toBe(false);

    store[Symbol.dispose]();
  });

  it("restores a focused pane history entry without discarding its forward history", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-a");
    store.showSession("session-c");

    expect(store.restoreFocusedHistorySession("session-a")).toBe(true);
    expect(store.focusedSessionId).toBe("session-a");
    expect(store.focusedSessionHistory).toEqual(["session-a", "session-c"]);

    store[Symbol.dispose]();
  });

  it("clamps and persists split geometry", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-a");
    store.splitFocused("session-b", "x");
    const splitId = store.layout?.kind === "split" ? store.layout.splitId : "";
    store.setSplitRatio(splitId, 0.95);
    expect(toSnapshot(store).state).toMatchObject({
      layout: { kind: "split", ratio: 0.8 },
      focusedPaneId: store.focusedPaneId,
    });

    store[Symbol.dispose]();
  });
});
