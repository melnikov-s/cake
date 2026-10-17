import { toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Split/close, pane numbers, navigation, visible-session reuse, limits and staged
// restoration's persisted forward branch live in session-layout-workflow.test.tsx.
// Family-child placement/reuse and native focus live in the Electron pane suites.
describe("Session layout native-geometry policy boundary", () => {
  // The Electron split workflow drags a real separator, but does not prove the
  // exact ratio clamp or its snapshot representation. Keep this real-composition
  // policy regression until native resize + window-state restoration coverage
  // exists; no fabricated DOM geometry or native input proof.
  it("clamps split geometry in the persisted layout snapshot", () => {
    using fixture = createRendererStoreFixture();
    const store = fixture.root.sessionLayoutStore;
    store.ensureSession("session-a");
    store.splitFocused("session-b", "x");
    const splitId = store.layout?.kind === "split" ? store.layout.splitId : "";
    store.setSplitRatio(splitId, 0.95);
    expect(toSnapshot(store).state).toMatchObject({
      layout: { kind: "split", ratio: 0.8 },
    });
  });
});
