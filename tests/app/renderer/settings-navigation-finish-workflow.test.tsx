/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderSearchableSettings() {
  const fixture = createRendererStoreFixture({
    client: { modelPresets: { list: async () => ({ presets: [] }) } },
  });
  fixture.root.settingsStore.applyApplicationState(0, defaultApplicationState());
  const view = render(<SettingsPage settings={fixture.root.settingsStore} browserMode />);
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Settings search navigation workflow", () => {
  it("finds settings across page metadata and live shortcut definitions, opens their pages and recovers from no matches", async () => {
    using fixture = renderSearchableSettings();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    const pages = within(screen.getByRole("navigation", { name: "Settings pages" }));

    await fixture.user.type(search, "auto-hide");
    expect(pages.getByText("VS Code", { exact: true })).toBeDefined();
    await fixture.user.click(pages.getByRole("button", { name: "Auto-hide project sidebar" }));
    expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("VS Code");
    expect(
      screen.getByRole("combobox", { name: "Auto-hide project sidebar in VS Code" }),
    ).toBeDefined();

    // Neither the setting label nor its page metadata contains both words alone.
    await fixture.user.clear(search);
    await fixture.user.type(search, "agent retry");
    expect(pages.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Automatic retry",
    ]);
    await fixture.user.click(pages.getByRole("button", { name: "Automatic retry" }));
    expect(screen.getByRole("heading", { name: "Agent", level: 2 })).toBeDefined();

    await fixture.user.clear(search);
    await fixture.user.type(search, "squash commit message");
    expect(pages.getByText("Instructions & prompts", { exact: true })).toBeDefined();
    await fixture.user.click(pages.getByRole("button", { name: "Squash commit message" }));
    expect(screen.getByRole("heading", { name: "Instructions & prompts", level: 2 })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Squash commit message" })).toBeDefined();

    // These results come from the real HotkeySettingsStore definitions, not a fake search item.
    await fixture.user.clear(search);
    await fixture.user.type(search, "toggle terminal");
    expect(pages.getByText("Hotkeys", { exact: true })).toBeDefined();
    await fixture.user.click(pages.getByRole("button", { name: "Toggle terminal" }));
    expect(screen.getByRole("heading", { name: "Hotkeys", level: 2 })).toBeDefined();
    expect(screen.getByRole("button", { name: "Toggle terminal shortcut" })).toBeDefined();

    for (const query of ["custom vocabulary", "known words", "aliases", "acoustic boosting"]) {
      await fixture.user.clear(search);
      await fixture.user.type(search, query);
      expect(pages.getByText("Voice & Dictation", { exact: true })).toBeDefined();
      await fixture.user.click(pages.getByRole("button", { name: "Custom vocabulary" }));
      expect(screen.getByRole("heading", { name: "Voice & Dictation", level: 2 })).toBeDefined();
    }

    await fixture.user.clear(search);
    await fixture.user.type(search, "unmatched-setting-query");
    expect(pages.getByRole("status").textContent).toBe(
      "No settings found for “unmatched-setting-query”.",
    );
    await fixture.user.keyboard("{Escape}");
    expect(search).toHaveProperty("value", "");
    await fixture.user.click(pages.getByRole("button", { name: /^Appearance/ }));
    expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe("Appearance");
  });
});
