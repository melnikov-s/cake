/**
 * @vitest-environment jsdom
 */
import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { HotkeySettingsStore } from "../../../../src/renderer/stores/HotkeySettingsStore";

const keyboardEvent = (key: string, modifiers: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, ...modifiers });

describe("HotkeySettingsStore", () => {
  it("matches default shortcuts and persists remaps", () => {
    using store = mount(createStore(HotkeySettingsStore));
    const platformModifier = /Mac/.test(navigator.userAgent)
      ? { metaKey: true }
      : { ctrlKey: true };

    expect(store.actionForEvent(keyboardEvent("b", platformModifier))).toBe("toggle-sidebar");
    expect(store.actionForEvent(keyboardEvent("g", platformModifier))).toBe("show-ui-hints");
    expect(
      store.actionForEvent(
        new KeyboardEvent("keydown", {
          key: "Dead",
          code: "Backquote",
          ...platformModifier,
        }),
      ),
    ).toBe("toggle-terminal");

    store.assign("toggle-sidebar", "Mod+Shift+B");

    expect(store.actionForEvent(keyboardEvent("b", platformModifier))).toBeUndefined();
    expect(store.actionForEvent(keyboardEvent("b", { ...platformModifier, shiftKey: true }))).toBe(
      "toggle-sidebar",
    );
    expect(toSnapshot(store).state.bindings).toEqual({ "toggle-sidebar": "Mod+Shift+B" });
  });

  it("moves a binding instead of leaving ambiguous duplicate shortcuts", () => {
    using store = mount(createStore(HotkeySettingsStore));

    store.assign("open-settings", "Mod+B");

    expect(store.bindingFor("open-settings")).toBe("Mod+B");
    expect(store.bindingFor("toggle-sidebar")).toBe("");
  });

  it("supports clearing, resetting one shortcut, and resetting all", () => {
    using store = mount(createStore(HotkeySettingsStore));

    store.clear("toggle-terminal");
    expect(store.bindingFor("toggle-terminal")).toBe("");
    store.reset("toggle-terminal");
    expect(store.bindingFor("toggle-terminal")).toBe("Mod+`");
    store.assign("toggle-terminal", "Mod+Y");
    store.resetAll();
    expect(store.bindingFor("toggle-terminal")).toBe("Mod+`");
  });
});
