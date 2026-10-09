/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import type { SettingsPageId } from "../../../src/renderer/stores/SettingsStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const pages: Array<{ page: SettingsPageId; title: string; introduction?: string }> = [
  { page: "models", title: "Models" },
  { page: "providers", title: "Providers" },
  { page: "agent", title: "Agent" },
  { page: "runtime", title: "Execution & resources" },
  { page: "network", title: "Network & privacy" },
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
describe("Settings page metadata presentation", () => {
  it.each(pages)(
    "renders the registered $page heading and introduction",
    async ({ page, title, introduction }) => {
      using fixture = createRendererStoreFixture({
        client: {
          modelPresets: { list: async () => ({ presets: [] }) },
          mcpSettings: { get: async () => ({ scope: {}, revision: "initial", entries: [] }) },
        },
      });
      fixture.root.settingsStore.selectPage(page);
      const view = render(<SettingsPage settings={fixture.root.settingsStore} browserMode />);
      try {
        expect(screen.getAllByRole("heading", { level: 2 })[0]?.textContent).toBe(title);
        expect(
          screen.getByText(
            introduction ??
              "Configure the same Pi runtime used by the CLI. Pi preferences follow you across projects.",
            { exact: true },
          ),
        ).toBeDefined();
        if (page === "mcp") await screen.findByText("No MCP servers configured.");
      } finally {
        view.unmount();
      }
    },
  );
});
