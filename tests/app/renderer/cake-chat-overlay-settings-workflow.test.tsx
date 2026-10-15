/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-data";
import { cakeChatOverlayHandoff } from "../../../src/renderer/bootstrap/start-cake-chat-overlay";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

function renderSettings(
  configure: Client["electron"]["configureCakeChatOverlay"],
  snapshot?: StoreSnapshot,
) {
  const fixture = createRendererStoreFixture({
    client: { electron: { configureCakeChatOverlay: configure } },
    snapshot,
  });
  fixture.root.settingsStore.applyApplicationState(0, defaultApplicationState());
  fixture.root.settingsStore.selectPage("cake-chat");
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  const recorder = () => screen.getByRole("button", { name: "Drop-down Cake Chat shortcut" });
  const controls = () => within(recorder().parentElement!);
  return {
    fixture,
    recorder,
    controls,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

describe("Drop-down Cake Chat settings workflow", () => {
  it("defaults to Command/Control+Backquote, turns it off, and persists the choice", async () => {
    const configure = vi.fn<Client["electron"]["configureCakeChatOverlay"]>(async () => undefined);
    let persisted: StoreSnapshot;
    {
      using view = renderSettings(configure);
      expect(view.recorder().textContent).toMatch(/^(Ctrl\+|⌘)`$/);
      await view.user.click(view.controls().getByRole("button", { name: "Clear" }));
      await waitFor(() =>
        expect(configure).toHaveBeenLastCalledWith(
          { shortcut: "", captureSelectedText: true },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(view.recorder().textContent).toBe("Not assigned");
      persisted = toSnapshot(view.fixture.root);
    }

    // A new window restores the preference from the window snapshot and hands it to main.
    configure.mockClear();
    using restored = renderSettings(configure, persisted);
    expect(restored.recorder().textContent).toBe("Not assigned");
    await restored.fixture.root.settingsStore.cakeChatOverlay.configure();
    expect(configure).toHaveBeenLastCalledWith(
      { shortcut: "", captureSelectedText: true },
      expect.anything(),
    );
    await restored.user.click(restored.controls().getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(configure).toHaveBeenLastCalledWith(
        { shortcut: "Mod+`", captureSelectedText: true },
        expect.anything(),
      ),
    );
    const selection = screen.getByRole("switch", { name: "Bring selected text along" });
    await restored.user.click(selection);
    await waitFor(() =>
      expect(configure).toHaveBeenLastCalledWith(
        { shortcut: "Mod+`", captureSelectedText: false },
        expect.anything(),
      ),
    );
    expect(toSnapshot(restored.fixture.root.settingsStore.cakeChatOverlay).state).toMatchObject({
      captureSelectedText: false,
    });
  });

  it("shows a registration conflict from main and clears it after a working change", async () => {
    const configure = vi
      .fn<Client["electron"]["configureCakeChatOverlay"]>()
      .mockRejectedValueOnce(new Error("Command+` is already used by another app"))
      .mockResolvedValue(undefined);
    using view = renderSettings(configure);
    await view.fixture.root.settingsStore.cakeChatOverlay.configure();
    expect(await screen.findByText("Command+` is already used by another app")).toBeDefined();
    await view.user.click(view.controls().getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(screen.queryByText("Command+` is already used by another app")).toBeNull(),
    );
  });
});

describe("Drop-down Cake Chat handoff", () => {
  it("keeps Cake Chat conversations and hands every other destination to a main window", () => {
    expect(cakeChatOverlayHandoff({ kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID })).toBe(
      undefined,
    );
    expect(cakeChatOverlayHandoff({ kind: "cake-chat" })).toBe(undefined);
    expect(cakeChatOverlayHandoff({ kind: "project-session", sessionId: "alpha" })).toEqual({
      sessionId: "alpha",
    });
    expect(cakeChatOverlayHandoff({ kind: "settings" })).toEqual({});
    expect(cakeChatOverlayHandoff({ kind: "workbench" })).toEqual({});
  });
});
