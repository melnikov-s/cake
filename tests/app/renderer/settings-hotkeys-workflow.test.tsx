/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsHotkeysSection } from "../../../src/renderer/components/settings-hotkeys-section";
import type { HotkeySettingsStore } from "../../../src/renderer/stores/HotkeySettingsStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderHotkeys(bindings: HotkeySettingsStore["bindings"] = {}) {
  const rootFixture = createRendererStoreFixture();
  rootFixture.root.settingsStore.hotkeys.bindings = bindings;
  const view = render(<SettingsHotkeysSection hotkeys={rootFixture.root.settingsStore.hotkeys} />);
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

function shortcut(label: string) {
  const recorder = screen.getByRole("button", { name: `${label} shortcut` });
  const group = recorder.parentElement;
  if (!group) throw new Error(`Missing shortcut controls for ${label}`);
  return {
    recorder,
    clear: within(group).getByRole("button", { name: "Clear" }),
    reset: within(group).getByRole("button", { name: "Reset" }),
  };
}

afterEach(cleanup);

// Native shortcut capture, focus, and dispatch are covered by tests/electron/hotkeys.smoke.spec.ts.
// These workflows exercise preference editing through the real Settings UI and Root Store tree.
describe("Hotkey settings workflow", () => {
  it("clears shortcuts, resets one without changing another, and restores all defaults", async () => {
    using fixture = renderHotkeys();
    const terminal = shortcut("Toggle terminal");
    const sidebar = shortcut("Toggle sidebar");

    expect(terminal.recorder.textContent).toMatch(/^(Ctrl\+|⌘)`$/);
    expect(terminal.reset).toHaveProperty("disabled", true);
    await fixture.user.click(terminal.clear);
    expect(terminal.recorder.textContent).toBe("Not assigned");
    expect(terminal.clear).toHaveProperty("disabled", true);
    expect(terminal.reset).toHaveProperty("disabled", false);

    await fixture.user.click(sidebar.clear);
    expect(sidebar.recorder.textContent).toBe("Not assigned");
    await fixture.user.click(terminal.reset);
    expect(terminal.recorder.textContent).toMatch(/^(Ctrl\+|⌘)`$/);
    expect(terminal.reset).toHaveProperty("disabled", true);
    expect(sidebar.recorder.textContent).toBe("Not assigned");

    await fixture.user.click(terminal.clear);
    await fixture.user.click(screen.getByRole("button", { name: "Reset all" }));
    expect(terminal.recorder.textContent).toMatch(/^(Ctrl\+|⌘)`$/);
    expect(sidebar.recorder.textContent).toMatch(/^(Ctrl\+|⌘)B$/);
    expect(terminal.clear).toHaveProperty("disabled", false);
    expect(sidebar.clear).toHaveProperty("disabled", false);
    expect(terminal.reset).toHaveProperty("disabled", true);
    expect(sidebar.reset).toHaveProperty("disabled", true);
  });

  it("reclaims a default shortcut from another action when resetting, then restores that action", async () => {
    using fixture = renderHotkeys({ "toggle-sidebar": "", "open-settings": "Mod+B" });
    const sidebar = shortcut("Toggle sidebar");
    const settings = shortcut("Toggle Settings");

    expect(sidebar.recorder.textContent).toBe("Not assigned");
    expect(settings.recorder.textContent).toMatch(/^(Ctrl\+|⌘)B$/);
    await fixture.user.click(sidebar.reset);
    expect(sidebar.recorder.textContent).toMatch(/^(Ctrl\+|⌘)B$/);
    expect(settings.recorder.textContent).toBe("Not assigned");
    expect(settings.clear).toHaveProperty("disabled", true);

    await fixture.user.click(settings.reset);
    expect(settings.recorder.textContent).toMatch(/^(Ctrl\+|⌘),$/);
    expect(sidebar.recorder.textContent).toMatch(/^(Ctrl\+|⌘)B$/);
    expect(settings.reset).toHaveProperty("disabled", true);
  });
});
