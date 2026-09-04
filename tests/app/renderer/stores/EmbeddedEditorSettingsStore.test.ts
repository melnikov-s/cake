import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { EmbeddedEditorSettingsStore } from "../../../../src/renderer/stores/EmbeddedEditorSettingsStore";

describe("EmbeddedEditorSettingsStore", () => {
  it("persists the VS Code sidebar auto-hide preference", () => {
    const store = mount(createStore(EmbeddedEditorSettingsStore));

    store.setSidebarAutoHide("below-width");
    store.setSidebarAutoHideWidth(1728);

    expect(toSnapshot(store).state).toEqual({
      sidebarAutoHide: "below-width",
      sidebarAutoHideWidth: 1728,
    });
    store[Symbol.dispose]();
  });
});
