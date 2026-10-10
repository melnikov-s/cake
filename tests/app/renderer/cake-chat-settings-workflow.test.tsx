/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);
it("persists the memory budget and dedicated instructions through the real Settings workflow", async () => {
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
    const instructions = screen.getByRole("textbox", { name: "Cake Chat instructions" });
    await user.type(instructions, "Always create worktrees.");
    await user.tab();
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        { instructions: "Always create worktrees.", memoryViewBytes: 10_000 },
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
