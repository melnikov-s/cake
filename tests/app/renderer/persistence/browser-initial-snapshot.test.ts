import { describe, expect, it } from "vitest";
import type { StoreSnapshot } from "r-state-tree";
import { browserInitialSnapshot } from "../../../../src/renderer/bootstrap/browser-initial-snapshot";
import { createRendererStoreFixture } from "../renderer-store-fixture";

function savedSidebar(hidden: boolean): StoreSnapshot {
  return {
    state: {},
    children: {
      sidebarStore: {
        state: { hidden, width: 330, navigationMode: "activity" },
        children: {},
      },
      appShellStore: { state: { selection: { kind: "cake-chat" } }, children: {} },
    },
  };
}

describe("browser initial sidebar presentation", () => {
  it.each([undefined, false, true])(
    "starts phones closed with saved hidden=%s without discarding other presentation",
    (hidden) => {
      const saved = hidden === undefined ? undefined : savedSidebar(hidden);
      const before = saved && structuredClone(saved);
      const initial = browserInitialSnapshot(saved, true);
      using fixture = createRendererStoreFixture({ snapshot: initial });
      expect(fixture.root.sidebarStore.visible).toBe(false);
      if (saved) {
        expect(initial.children.appShellStore).toBe(saved.children.appShellStore);
        expect(fixture.root.sidebarStore.width).toBe(330);
        expect(fixture.root.sidebarStore.navigationMode).toBe("activity");
        expect(saved).toEqual(before);
      }
    },
  );

  it.each([undefined, false, true])(
    "keeps desktop browser defaults and restored hidden=%s",
    (hidden) => {
      const saved = hidden === undefined ? undefined : savedSidebar(hidden);
      const initial = browserInitialSnapshot(saved, false);
      if (saved) expect(initial).toBe(saved);
      using fixture = createRendererStoreFixture({ snapshot: initial });
      expect(fixture.root.sidebarStore.visible).toBe(hidden !== true);
    },
  );
});
