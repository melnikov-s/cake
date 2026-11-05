/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, mount } from "r-state-tree";
import { DesktopConnectionStore } from "../../../src/renderer/stores/DesktopConnectionStore";
import { createTestClient } from "./test-client";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";
import { settingsDestinations } from "../../../src/contracts/application/settings-navigation";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { defaultLocalMcpConfiguration } from "../../../src/contracts/mcp/local-mcp";
import type { SettingsPageId } from "../../../src/contracts/application/settings-navigation";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const pages: Array<{ page: SettingsPageId; title: string; introduction?: string }> = [
  { page: "models", title: "Models" },
  { page: "providers", title: "Providers" },
  { page: "agent", title: "Agent" },
  { page: "runtime", title: "Execution & resources" },
  {
    page: "network",
    title: "Network & privacy",
    introduction: "Host connection, remote access, provider transport, and privacy.",
  },
  { page: "mcp", title: "MCP servers" },
  { page: "appearance", title: "Appearance" },
  { page: "editor", title: "VS Code" },
  {
    page: "voice",
    title: "Voice & Dictation",
    introduction:
      "Shared speech recognition, text processing, and voice output for dictation and conversation mode.",
  },
  {
    page: "labels",
    title: "Session labels",
    introduction: "Create the labels available across all projects.",
  },
  {
    page: "prompts",
    title: "Instructions & prompts",
    introduction: "Set personal agent instructions and customize Cake's workflow messages.",
  },
  {
    page: "hotkeys",
    title: "Hotkeys",
    introduction: "Customize Cake's application shortcuts. Changes take effect immediately.",
  },
];

afterEach(cleanup);
describe("Settings section navigation", () => {
  it("opens and highlights stable settings via authorized tools and shares voice preferences with UI", async () => {
    using connection = mount(
      createStore(DesktopConnectionStore, {
        host: { kind: "local" },
        client: () => createTestClient(),
        connect: async () => {},
      }),
    );
    const flushWindowState = vi.fn(async () => {});
    using fixture = createRendererStoreFixture({ desktopConnection: connection, flushWindowState });
    const settings = fixture.root.settingsStore;
    const call = (name: string, args: JsonObject = {}) =>
      act(async () => fixture.root.applicationControlStore.invoke({ name, arguments: args }));
    render(<SettingsPage settings={settings} />);
    settings.agentNavigation.setEnabled(false);
    await expect(call("settings.open", { setting: "dictation.voiceSubmit" })).rejects.toThrow(
      "disabled",
    );
    expect(settings.activePage).toBe("models");
    expect(settings.agentNavigation.enabled).toBe(false);
    settings.agentNavigation.setEnabled(true); // User-owned authorization, not a tool write.
    await call("settings.open", { setting: "dictation.voiceSubmit" });
    expect(settings.activePage).toBe("voice");
    expect(fixture.root.appShellStore.selection.kind).toBe("settings");
    await waitFor(() =>
      expect(
        document
          .getElementById("setting-dictation-voice-submit")
          ?.getAttribute("data-settings-highlighted"),
      ).toBe("true"),
    );
    const toggle = screen.getByRole("switch", { name: "Submit message by voice" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await call("settings.dictation.update", {
      action: "voice-submit",
      enabled: true,
      phrase: "over and out",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Submit phrase" }).value).toBe(
      "over and out",
    );
    const user = userEvent.setup();
    await user.clear(screen.getByRole("textbox", { name: "Submit phrase" }));
    await user.type(screen.getByRole("textbox", { name: "Submit phrase" }), "send it now");
    expect(await call("settings.dictation.get")).toMatchObject({
      value: { speechInput: { dictationVoiceSend: true, dictationSendPhrase: "send it now" } },
    });
    expect(flushWindowState).toHaveBeenCalled();
    // All registered identities resolve to visible UI, including a disabled phrase's parent.
    await user.click(toggle);
    for (const setting of Object.keys(settingsDestinations)) {
      await call("settings.open", { setting });
      const target = settings.scrollRequest?.targetId;
      expect(
        target && document.getElementById(target)?.getAttribute("data-settings-highlighted"),
      ).toBe("true");
    }
    await call("settings.open", { page: "appearance" });
    expect(settings.activePage).toBe("appearance");
    expect(document.querySelector("[data-settings-highlighted]")).toBeNull();
    await expect(call("settings.open", { setting: "arbitrary-selector" })).rejects.toThrow();
  });
  it("opens the registered sections with their headings and introductions", async () => {
    using fixture = createRendererStoreFixture({
      client: {
        modelPresets: { list: async () => ({ presets: [] }) },
        mcpSettings: {
          get: async () => ({ scope: {}, revision: "initial", entries: [] }),
          serverGet: async () => ({
            configuration: defaultLocalMcpConfiguration(),
            runtime: { status: "disabled" },
          }),
        },
      },
    });
    const user = userEvent.setup();
    const view = render(<SettingsPage settings={fixture.root.settingsStore} browserMode />);
    try {
      const navigation = within(screen.getByRole("navigation", { name: "Settings pages" }));
      for (const { page, title, introduction } of pages) {
        await user.click(
          navigation.getByRole("button", { name: new RegExp(`^${title}(?:\\s|$)`) }),
        );
        expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe(title);
        if (page !== "mcp")
          expect(
            screen.getByText(
              introduction ??
                "Configure the same Pi runtime used by the CLI. Pi preferences follow you across projects.",
              { exact: true },
            ),
          ).toBeDefined();
        if (page === "mcp") await screen.findByText("No MCP servers configured.");
      }
    } finally {
      view.unmount();
    }
  });
});
