/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);
it("persists the active context limit, memory budget and dedicated instructions through the real Settings workflow", async () => {
  let revision = 0;
  const save = vi.fn<Client["workspaces"]["setCakeChatPreferences"]>(async (preferences) => {
    const state = { ...defaultApplicationState(), cakeChatPreferences: preferences };
    fixture.root.settingsStore.applyApplicationState(++revision, state);
    return state;
  });
  using fixture = createRendererStoreFixture({
    client: { workspaces: { setCakeChatPreferences: save } },
  });
  fixture.root.settingsStore.applyApplicationState(0, defaultApplicationState());
  fixture.root.settingsStore.selectPage("cake-chat");
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  try {
    const user = userEvent.setup();
    const budget = screen.getByRole("combobox", { name: "Cake Chat history-view budget" });
    expect(budget).toHaveProperty("value", "40000");
    await user.selectOptions(budget, "10000");
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        { ...defaultCakeChatPreferences(), memoryViewBytes: 10_000 },
        expect.anything(),
      ),
    );
    const limit = screen.getByRole("combobox", { name: "Cake Chat active context limit" });
    expect(limit).toHaveProperty("value", "300000");
    await user.selectOptions(limit, "64000");
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        { ...defaultCakeChatPreferences(), memoryViewBytes: 10_000, contextLimitTokens: 64_000 },
        expect.anything(),
      ),
    );
    const instructions = screen.getByRole("textbox", { name: "Cake Chat instructions" });
    await user.type(instructions, "Always create worktrees.");
    await user.tab();
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        {
          instructions: "Always create worktrees.",
          memoryViewBytes: 10_000,
          contextLimitTokens: 64_000,
        },
        expect.anything(),
      ),
    );
    expect(screen.getByDisplayValue("Always create worktrees.")).toBe(instructions);
  } finally {
    view.unmount();
  }
});

it("shows a failed preference save and permits retry without discarding persisted instructions", async () => {
  const save = vi
    .fn<Client["workspaces"]["setCakeChatPreferences"]>()
    .mockRejectedValueOnce(new Error("Could not save memory settings"))
    .mockImplementation(async (preferences) => ({
      ...defaultApplicationState(),
      cakeChatPreferences: preferences,
    }));
  using fixture = createRendererStoreFixture({
    client: { workspaces: { setCakeChatPreferences: save } },
  });
  fixture.root.settingsStore.applyApplicationState(0, defaultApplicationState());
  fixture.root.settingsStore.selectPage("cake-chat");
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  try {
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Cake Chat history-view budget" }),
      "10000",
    );
    expect(await screen.findByText("Could not save memory settings")).toBeDefined();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Cake Chat history-view budget" }),
      "40000",
    );
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Could not save memory settings")).toBeNull());
  } finally {
    view.unmount();
  }
});

it.each([
  ["subagentDefaultModel", "Subagent default model", "inherit", "Inherit chat model (default)"],
  ["summarizationModel", "Summarization model", "utility", "Utility model (default, gpt-mini)"],
] as const)(
  "persists every %s choice through the shared Settings model-choice field",
  async (setting, label, defaultSource, defaultOption) => {
    const presets = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Astra",
        provider: "anthropic",
        modelId: "claude-opus",
        thinkingLevel: "high" as const,
        fastMode: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "Flash",
        provider: "google",
        modelId: "gemini-flash",
        thinkingLevel: "low" as const,
        fastMode: false,
      },
    ];
    const base = {
      ...defaultApplicationState(),
      modelPresets: presets,
      defaultModelPresetId: presets[0]!.id,
      utilityModel: { provider: "openai", modelId: "gpt-mini", thinkingLevel: "off" as const },
    };
    let revision = 0;
    const save = vi.fn<Client["workspaces"]["setCakeChatPreferences"]>(async (preferences) => {
      const state = { ...base, cakeChatPreferences: preferences };
      fixture.root.settingsStore.applyApplicationState(++revision, state);
      return state;
    });
    using fixture = createRendererStoreFixture({
      client: { workspaces: { setCakeChatPreferences: save } },
    });
    fixture.root.settingsStore.applyApplicationState(0, base);
    fixture.root.settingsStore.selectPage("cake-chat");
    const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
    try {
      const user = userEvent.setup();
      const select = screen.getByRole("combobox", { name: label });
      expect(select).toHaveProperty("value", defaultSource);
      const options = within(select);
      expect(options.getByRole("option", { name: defaultOption })).toBeDefined();
      expect(options.getByRole("option", { name: "Default preset (Astra)" })).toBeDefined();

      const choices = [
        ["inherit", { source: "inherit" }],
        ["default", { source: "default" }],
        ["utility", { source: "utility" }],
        [`preset:${presets[1]!.id}`, { source: "preset", presetId: presets[1]!.id }],
      ] as const;
      for (const [value, choice] of choices) {
        if (value === defaultSource) continue;
        await user.selectOptions(select, value);
        await waitFor(() =>
          expect(save).toHaveBeenLastCalledWith(
            { ...defaultCakeChatPreferences(), [setting]: choice },
            expect.anything(),
          ),
        );
        expect(select).toHaveProperty("value", value);
      }

      // Choosing the setting's default stores nothing, matching the out-of-the-box value.
      await user.selectOptions(select, defaultSource);
      await waitFor(() =>
        expect(save).toHaveBeenLastCalledWith(defaultCakeChatPreferences(), expect.anything()),
      );

      // A specific model needs a picked model before anything is saved.
      const saves = save.mock.calls.length;
      await user.selectOptions(select, "model");
      expect(screen.getByRole("button", { name: `${label} configuration` })).toBeDefined();
      expect(save).toHaveBeenCalledTimes(saves);

      // A saved freeform model shows as the specific-model choice with its model ID.
      const freeform = {
        provider: "custom",
        modelId: "not-a-preset",
        thinkingLevel: "medium" as const,
        fastMode: true,
      };
      await fixture.root.settingsStore.cakeChat.setModelChoice(setting, {
        source: "model",
        model: freeform,
      });
      expect(save).toHaveBeenLastCalledWith(
        { ...defaultCakeChatPreferences(), [setting]: { source: "model", model: freeform } },
        expect.anything(),
      );
      await waitFor(() => expect(select).toHaveProperty("value", "model"));
      expect(screen.getByRole("button", { name: `${label} configuration` }).textContent).toContain(
        "not-a-preset",
      );
    } finally {
      view.unmount();
    }
  },
);
