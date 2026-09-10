import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { SettingsStore } from "../../../../src/renderer/stores/SettingsStore";

function createSettingsStore() {
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  return mount(
    createStore(SettingsStore, {
      operations,
      activeSession: () => undefined,
      workbenchError: () => undefined,
    }),
  );
}

describe("SettingsStore agent controls", () => {
  it("reads effective values and patches only supplied window settings", () => {
    const settings = createSettingsStore();

    expect(settings.settingsSection("appearance")).toMatchObject({
      section: "appearance",
      settings: {
        theme: "system",
        projectAvatarsEnabled: true,
        sessionAvatarsEnabled: true,
      },
    });

    expect(
      settings.updateSettings({ section: "appearance", changes: { theme: "dark" } }),
    ).toMatchObject({
      section: "appearance",
      settings: {
        theme: "dark",
        projectAvatarsEnabled: true,
        sessionAvatarsEnabled: true,
      },
    });
    expect(
      settings.updateSettings({
        section: "editor",
        changes: { sidebarAutoHide: "below-width", sidebarAutoHideWidth: 1728 },
      }),
    ).toEqual({
      section: "editor",
      settings: { sidebarAutoHide: "below-width", sidebarAutoHideWidth: 1728 },
    });
  });

  it("assigns, disables, and restores effective hotkey bindings", () => {
    const settings = createSettingsStore();

    settings.updateSettings({
      section: "hotkeys",
      changes: { bindings: [{ action: "open-settings", binding: "Mod+Shift+," }] },
    });
    expect(settings.hotkeys.bindingFor("open-settings")).toBe("Mod+Shift+,");

    settings.updateSettings({
      section: "hotkeys",
      changes: { bindings: [{ action: "open-settings", binding: "" }] },
    });
    expect(settings.hotkeys.bindingFor("open-settings")).toBe("");

    const result = settings.updateSettings({
      section: "hotkeys",
      changes: { bindings: [{ action: "open-settings", binding: null }] },
    });
    expect(settings.hotkeys.bindingFor("open-settings")).toBe("Mod+,");
    expect(result.section).toBe("hotkeys");
    if (result.section === "hotkeys")
      expect(result.settings.bindings).toContainEqual(
        expect.objectContaining({
          action: "open-settings",
          binding: "Mod+,",
          customized: false,
        }),
      );
  });
});
