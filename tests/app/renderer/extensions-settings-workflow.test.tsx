/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import type { PiExtensionSetting } from "../../../src/contracts/pi/extension-settings-data";
import { projectPiSettings } from "../../../src/services/pi/runtime/settings-translation";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const settings = projectPiSettings(SettingsManager.inMemory({}));
const extension: PiExtensionSetting = {
  id: "/fixture/extensions/example.ts",
  name: "example.ts",
  path: "/fixture/extensions/example.ts",
  source: "auto",
  enabled: true,
};
async function fixture(piSettings: TestClientOverrides["piSettings"]) {
  const stores = createRendererStoreFixture({
    client: {
      models: { list: async () => [] },
      piSettings: { get: async () => settings, ...piSettings },
    },
  });
  await stores.root.settingsStore.providers.hydrate();
  stores.root.settingsStore.selectPage("runtime");
  const view = render(<SettingsPage settings={stores.root.settingsStore} />);
  return {
    stores,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      stores[Symbol.dispose]();
    },
  };
}
afterEach(cleanup);

describe("Automatic extension settings workflow", () => {
  it("loads authoritative discovery, disables duplicate requests while saving, and refreshes native enabled status", async () => {
    let enabled = true;
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const toggle = vi.fn<Client["piSettings"]["setExtensionEnabled"]>(async (input) => {
      await gate;
      enabled = input.enabled;
      return settings;
    });
    const list = vi.fn<Client["piSettings"]["extensions"]>(async () => [
      { ...extension, enabled },
      {
        id: "builtin:mcp",
        name: "builtin:mcp",
        path: "builtin:mcp",
        source: "builtin",
        enabled: false,
      },
    ]);
    using f = await fixture({ extensions: list, setExtensionEnabled: toggle });
    const automatic = await screen.findByRole("switch", { name: "example.ts" });
    const builtin = screen.getByRole("switch", { name: "builtin:mcp" });
    expect(automatic.getAttribute("aria-checked")).toBe("true");
    expect(builtin.getAttribute("aria-checked")).toBe("false");
    await f.user.click(automatic);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle.mock.calls[0]?.[0]).toEqual({ id: extension.id, enabled: false });
    expect(automatic.hasAttribute("disabled")).toBe(true);
    expect(builtin.hasAttribute("disabled")).toBe(true);
    expect(automatic.getAttribute("aria-checked")).toBe("true");
    await f.user.click(automatic);
    expect(toggle).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(automatic.getAttribute("aria-checked")).toBe("false"));
    expect(automatic.hasAttribute("disabled")).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
    await f.user.click(screen.getByRole("button", { name: "Refresh extensions" }));
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("shows a failed native update without presenting a successful toggle", async () => {
    using f = await fixture({
      extensions: async () => [extension],
      setExtensionEnabled: async () => {
        throw new Error("Cannot update extension");
      },
    });
    const automatic = await screen.findByRole("switch", { name: "example.ts" });
    await f.user.click(automatic);
    await screen.findByText("Cannot update extension");
    expect(automatic.getAttribute("aria-checked")).toBe("true");
    expect(automatic.hasAttribute("disabled")).toBe(false);
  });
});
