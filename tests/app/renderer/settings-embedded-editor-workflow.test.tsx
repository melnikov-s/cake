/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsEmbeddedEditorSection } from "../../../src/renderer/components/settings-embedded-editor-section";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderEditorSettings() {
  const rootFixture = createRendererStoreFixture();
  const view = render(
    <SettingsEmbeddedEditorSection settings={rootFixture.root.settingsStore.embeddedEditor} />,
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

describe("Embedded editor settings workflow", () => {
  it("shows the width setting only for conditional auto-hide and retains the chosen width across mode changes", async () => {
    using fixture = renderEditorSettings();
    const mode = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Auto-hide project sidebar in VS Code",
    });
    const widthName = "VS Code sidebar auto-hide window width";

    expect(mode.value).toBe("never");
    expect(screen.queryByRole("combobox", { name: widthName })).toBeNull();

    await fixture.user.selectOptions(mode, "below-width");
    const width = screen.getByRole<HTMLSelectElement>("combobox", { name: widthName });
    expect(width.value).toBe("1440");
    await fixture.user.selectOptions(width, "1728");
    expect(width.value).toBe("1728");

    await fixture.user.selectOptions(mode, "always");
    expect(mode.value).toBe("always");
    expect(screen.queryByRole("combobox", { name: widthName })).toBeNull();

    await fixture.user.selectOptions(mode, "never");
    expect(mode.value).toBe("never");
    expect(screen.queryByRole("combobox", { name: widthName })).toBeNull();

    await fixture.user.selectOptions(mode, "below-width");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: widthName }).value).toBe("1728");
  });
});
