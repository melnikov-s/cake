/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsAppearanceSection } from "../../../src/renderer/components/settings-appearance-section";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderAppearanceSettings() {
  const rootFixture = createRendererStoreFixture();
  const view = render(
    <SettingsAppearanceSection appearance={rootFixture.root.settingsStore.appearance} />,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Appearance settings workflow", () => {
  it("lets users independently disable and re-enable project and session avatars", async () => {
    using fixture = renderAppearanceSettings();
    const projects = screen.getByRole("switch", { name: "Project avatars" });
    const sessions = screen.getByRole("switch", { name: "Session avatars" });

    expect(projects.getAttribute("aria-checked")).toBe("true");
    expect(sessions.getAttribute("aria-checked")).toBe("true");

    await fixture.user.click(projects);
    expect(projects.getAttribute("aria-checked")).toBe("false");
    expect(sessions.getAttribute("aria-checked")).toBe("true");

    await fixture.user.click(sessions);
    expect(projects.getAttribute("aria-checked")).toBe("false");
    expect(sessions.getAttribute("aria-checked")).toBe("false");

    await fixture.user.click(projects);
    expect(projects.getAttribute("aria-checked")).toBe("true");
    expect(sessions.getAttribute("aria-checked")).toBe("false");

    await fixture.user.click(sessions);
    expect(projects.getAttribute("aria-checked")).toBe("true");
    expect(sessions.getAttribute("aria-checked")).toBe("true");
  });

  it("lets users choose either fixed theme and return to the system preference", async () => {
    using fixture = renderAppearanceSettings();
    const theme = screen.getByRole("combobox", { name: "Color theme" });
    const selectedTheme = () => screen.getByRole("option", { selected: true }).textContent;

    expect(selectedTheme()).toBe("System");
    await fixture.user.selectOptions(theme, "dark");
    expect(selectedTheme()).toBe("Dark");
    await fixture.user.selectOptions(theme, "light");
    expect(selectedTheme()).toBe("Light");
    await fixture.user.selectOptions(theme, "system");
    expect(selectedTheme()).toBe("System");
  });
});
