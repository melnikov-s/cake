import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_PANES,
  SessionLayoutStore,
} from "../../../../src/renderer/stores/SessionLayoutStore";

describe("SessionLayoutStore", () => {
  it("splits the focused pane and keeps exactly one focused session", () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000003");
    const store = mount(createStore(SessionLayoutStore));

    store.ensureSession("session-a");
    store.splitFocused("session-b", "x");

    expect(store.panes).toEqual([
      {
        paneId: "00000000-0000-4000-8000-000000000001",
        sessionId: "session-a",
        number: 1,
        focused: false,
      },
      {
        paneId: "00000000-0000-4000-8000-000000000002",
        sessionId: "session-b",
        number: 2,
        focused: true,
      },
    ]);
    expect(store.layout).toMatchObject({ kind: "split", axis: "x", ratio: 0.5 });
    expect(store.neighbors("session-b")).toMatchObject({
      left: [{ sessionId: "session-a" }],
      right: [],
      above: [],
      below: [],
    });

    store[Symbol.dispose]();
    vi.restoreAllMocks();
  });

  it("only exposes pane numbers while the layout is split", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-a");
    expect(store.paneNumber("session-a")).toBeUndefined();

    store.splitFocused("session-b", "x");
    expect(store.paneNumber("session-a")).toBe(1);
    expect(store.paneNumber("session-b")).toBe(2);

    store.closePane(store.focusedPaneId!);
    expect(store.paneNumber("session-a")).toBeUndefined();

    store[Symbol.dispose]();
  });

  it("uses the focused pane for navigation and focuses an already visible session", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-a");
    store.splitFocused("session-b", "x");
    const firstPaneId = store.panes[0]!.paneId;

    store.focusPane(firstPaneId);
    store.showSession("session-c");
    expect(store.focusedSessionId).toBe("session-c");
    expect(store.goBack()).toBe("session-a");
    expect(store.focusedSessionId).toBe("session-a");
    expect(store.goBack()).toBeUndefined();

    store.showSession("session-b");
    expect(store.panes).toHaveLength(2);
    expect(store.focusedSessionId).toBe("session-b");

    store[Symbol.dispose]();
  });

  it("collapses the parent split when a pane closes", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-a");
    store.splitFocused("session-b", "y");
    const closingPaneId = store.focusedPaneId!;

    expect(store.closePane(closingPaneId)).toEqual({
      removedSessionIds: ["session-b"],
      focusedSessionId: "session-a",
    });
    expect(store.layout).toMatchObject({ kind: "pane", history: ["session-a"] });
    expect(store.focusedSessionId).toBe("session-a");

    store[Symbol.dispose]();
  });

  it("persists layout geometry and limits the number of panes", () => {
    const store = mount(createStore(SessionLayoutStore));
    store.ensureSession("session-0");
    for (let index = 1; index < MAX_SESSION_PANES; index += 1)
      store.splitFocused(`session-${index}`, index % 2 ? "x" : "y");

    expect(store.canSplit).toBe(false);
    expect(store.splitFocused("too-many", "x")).toBeUndefined();
    const splitId = store.layout?.kind === "split" ? store.layout.splitId : "";
    store.setSplitRatio(splitId, 0.95);
    expect(store.layout).toMatchObject({ ratio: 0.8 });
    expect(toSnapshot(store).state).toMatchObject({ focusedPaneId: store.focusedPaneId });

    store[Symbol.dispose]();
  });
});
