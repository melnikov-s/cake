import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { AppearanceSettingsStore } from "../../../../src/renderer/stores/AppearanceSettingsStore";

describe("AppearanceSettingsStore", () => {
  it("enables avatars by default and persists independent toggles", () => {
    const store = mount(createStore(AppearanceSettingsStore));

    expect(store.projectAvatarsEnabled).toBe(true);
    expect(store.sessionAvatarsEnabled).toBe(true);

    store.setProjectAvatarsEnabled(false);
    expect(toSnapshot(store).state).toMatchObject({
      projectAvatarsEnabled: false,
      sessionAvatarsEnabled: true,
    });
    store[Symbol.dispose]();
  });
});
