/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { observer, StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppNotifications } from "../../../src/renderer/components/app-notifications";
import { Chat } from "../../../src/renderer/components/chat";
import { SettingsAppearanceSection } from "../../../src/renderer/components/settings-appearance-section";
import type { Client } from "../../../src/renderer/client/Client";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { AgentControlSource } from "../../../src/renderer/app-control/app-control-data";
import type { TestClientOverrides } from "./test-client";
import { createCommandClientFinishFixture } from "./command-client-finish-fixture";

function renderCommandClientFinish(client: TestClientOverrides = {}, flush?: () => Promise<void>) {
  const fixture = createCommandClientFinishFixture(client, flush);
  const Conversation = observer(function Conversation() {
    const active = fixture.root.projectWorkbenchStore.activeSession;
    return active ? (
      <Chat
        store={active.conversationSessionStore.chatStore}
        compact
        composerFocusEnabled={false}
      />
    ) : null;
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
        <Conversation />
        <SettingsAppearanceSection appearance={fixture.root.settingsStore.appearance} />
        <AppNotifications />
      </StoreProvider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    begin: fixture.invoke,
    async invoke(name: string, args = {}, source?: AgentControlSource) {
      return act(() => fixture.invoke(name, args, source));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.useRealTimers();
});

// Agent commands enter at their real public gateway, not a fabricated UI action.
// React proves their user-visible result and subsequent user interactions.
// Native input/focus, selection gestures and portal geometry are not claimed.
describe("Application command to renderer workflows", () => {
  it("commits window settings before acknowledging, updates the real settings controls, and lets the user edit them afterward", async () => {
    const persisted = Promise.withResolvers<void>();
    const flush = vi.fn(() => persisted.promise);
    using fixture = renderCommandClientFinish({}, flush);
    let completed = false;
    let saving!: Promise<unknown>;
    await act(async () => {
      // Deliberately do not await command completion until persistence is released.
      saving = fixture
        .begin("settings.window.update", {
          section: "appearance",
          changes: { theme: "dark", sidebarCharactersEnabled: true },
        })
        .then((result) => {
          completed = true;
          return result;
        });
    });
    expect(screen.getByRole("combobox", { name: "Color theme" })).toHaveProperty("value", "dark");
    expect(
      screen.getByRole("switch", { name: "Show session characters" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(flush).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    await act(async () => persisted.resolve());
    expect(await saving).toMatchObject({ ok: true, scope: "window", settings: { theme: "dark" } });
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Color theme" }),
      "light",
    );
    await fixture.user.click(screen.getByRole("switch", { name: "Show session characters" }));
    expect(await fixture.invoke("settings.window.get", { section: "appearance" })).toMatchObject({
      ok: true,
      settings: { theme: "light", sidebarCharactersEnabled: false },
    });
    await expect(
      fixture.invoke("settings.window.update", { section: "appearance", changes: {} }),
    ).rejects.toThrow();
    expect(screen.getByRole("combobox", { name: "Color theme" })).toHaveProperty("value", "light");
  });

  it("coalesces committed rename receipts, lets the user view the target, and suppresses Cake Chat coordination receipts without suppressing its own actions", async () => {
    const rename = vi.fn<Client["projectSessions"]["rename"]>(async () => undefined);
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => undefined);
    using fixture = renderCommandClientFinish({
      projectSessions: { rename, open },
      sessionChats: { abort },
    });
    const input = { sessionId: "target", title: "  Storage implementation  " };
    await fixture.invoke("sessions.rename", input);
    await fixture.invoke("sessions.rename", input);
    expect(rename).toHaveBeenCalledWith(
      { sessionId: "target", name: "Storage implementation" },
      { signal: expect.any(AbortSignal) },
    );
    let receipts = screen.getAllByRole("status");
    expect(receipts).toHaveLength(1);
    expect(within(receipts[0]!).getByText("Agent action · Planner")).toBeDefined();
    expect(
      within(receipts[0]!).getByText("Renamed session to “Storage implementation”"),
    ).toBeDefined();
    await fixture.user.click(within(receipts[0]!).getByRole("button", { name: "View" }));
    expect(await fixture.invoke("app.state")).toMatchObject({
      state: { selection: { sessionId: "target" } },
    });
    expect(screen.getByText("Conversation: Other work")).toBeDefined();
    const cake = {
      kind: "cake-chat",
      sessionId: "cake-chat",
      title: "Cake Chat",
    } satisfies AgentControlSource;
    await fixture.invoke("sessions.abort", { sessionId: "target" }, cake);
    expect(abort).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    await fixture.invoke("agent.action", { action: "set-model", detail: "fixture/model" }, cake);
    receipts = screen.getAllByRole("status");
    expect(receipts).toHaveLength(2);
    expect(screen.getByText("Changed this session’s model to fixture/model")).toBeDefined();
    const receipt = screen.getByText("Agent action · Cake Chat").closest('[role="status"]');
    if (!(receipt instanceof HTMLElement)) throw new Error("Missing Cake Chat receipt");
    await fixture.user.click(within(receipt).getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Agent action · Cake Chat")).toBeNull();
  });

  it("silently lets Cake Chat create sibling work while reporting the same creation by a Project Session", async () => {
    const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderCommandClientFinish({ projectSessions: { start } });
    const args = { workspacePath: "/project", name: "New work", initialPrompt: "Go" };
    const cake = {
      kind: "cake-chat",
      sessionId: "cake-chat",
      title: "Cake Chat",
    } satisfies AgentControlSource;
    expect(await fixture.invoke("sessions.create", args, cake)).toMatchObject({ ok: true });
    expect(screen.queryByRole("status")).toBeNull();
    expect(await fixture.invoke("sessions.create", args)).toMatchObject({ ok: true });
    expect(screen.getByRole("status").textContent).toContain("Created and started “New work”");
    expect(screen.getByText("Agent action · Planner")).toBeDefined();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("routes attributed notifications through native delivery and a visible toast without adding an agent-action receipt", async () => {
    vi.useFakeTimers();
    const showNotification = vi.fn<Client["electron"]["showNotification"]>(async () => undefined);
    using fixture = renderCommandClientFinish({ electron: { showNotification } });
    expect(
      await fixture.invoke("notifications.send", {
        title: "Build progress",
        body: "Tests reached 80%.",
      }),
    ).toMatchObject({ ok: true, status: "queued" });
    expect(screen.queryByText("Agent action · Planner")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      {
        title: "Build progress · Planner",
        body: "Tests reached 80%.",
        level: "info",
        id: "cake-agent:calling",
        groupId: "cake-agent:calling",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("status").textContent).toContain("Tests reached 80%.");
    expect(screen.queryByText("Agent action · Planner")).toBeNull();
  });

  // Incoming native-selection adapter only: no synthetic drag or layout proof.
  it("reads the current incoming native text selection without retaining a stale value", async () => {
    using fixture = renderCommandClientFinish();
    const label = screen.getByRole("heading", { name: "Appearance" });
    const range = document.createRange();
    range.selectNodeContents(label);
    window.getSelection()?.addRange(range);
    expect(await fixture.invoke("app.user-selection")).toEqual({
      ok: true,
      command: "app.user-selection",
      text: "Appearance",
    });
    window.getSelection()?.removeAllRanges();
    expect(await fixture.invoke("app.user-selection")).toEqual({
      ok: true,
      command: "app.user-selection",
      text: null,
    });
  });
});
