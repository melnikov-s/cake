import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionLayoutStore } from "../../../../src/renderer/stores/SessionLayoutStore";

// Split/close, pane numbers, navigation, visible-session reuse and limits live in
// session-layout-workflow.test.tsx. Family-child placement/reuse and native focus
// live in tests/electron/child-session-pane.smoke.spec.ts; adjacent-pane keyboard
// navigation and real drag geometry live in tests/electron/session-split.smoke.spec.ts.
describe("SessionLayoutStore remaining contracts", () => {
  // root-app-workflow covers staged-draft restoration, not retention of the pane's
  // forward branch. Sidebar Forward is gated by shell history, which records New
  // Chat restoration as a new visit; it cannot prove this distinct pane contract.
  it("restores a focused pane history entry without discarding its forward history", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-a");
    store.showSession("session-c");

    expect(store.restoreFocusedHistorySession("session-a")).toBe(true);
    expect(store.focusedSessionId).toBe("session-a");
    expect(store.focusedSessionHistory).toEqual(["session-a", "session-c"]);

    store[Symbol.dispose]();
  });

  // The Electron split workflow drags a real separator, but does not prove the
  // exact ratio clamp or its snapshot representation. Keep this policy regression
  // until native resize + window-state restoration coverage exists; no DOM geometry fake.
  it("clamps split geometry in the persisted layout snapshot", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-a");
    store.splitFocused("session-b", "x");
    const splitId = store.layout?.kind === "split" ? store.layout.splitId : "";
    store.setSplitRatio(splitId, 0.95);
    expect(toSnapshot(store).state).toMatchObject({
      layout: { kind: "split", ratio: 0.8 },
    });

    store[Symbol.dispose]();
  });
});
