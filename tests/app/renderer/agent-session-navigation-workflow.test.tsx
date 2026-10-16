/** @vitest-environment jsdom */
import { act, cleanup, screen } from "@testing-library/react";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageReference } from "../../../src/contracts/conversations/message-reference";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { WindowStatePersistence } from "../../../src/renderer/persistence/WindowStatePersistence";
import { searchSettings } from "../../../src/renderer/lib/settings-search";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";
import { createRendererStoreFixture } from "./renderer-store-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

const sessionButton = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name} conversation `) });
const expectChat = async (name: string) =>
  expect(await screen.findByPlaceholderText(`Ask Cake to work in ${name}…`)).toBeDefined();
const openSettings = async (fixture: ReturnType<typeof renderAppShellNavigation>) => {
  const settingsButton = screen.queryAllByRole("button", { name: "Open settings" })[0];
  if (settingsButton) await fixture.user.click(settingsButton);
  await fixture.user.click(screen.getByRole("button", { name: /^Agent Behavior and content$/ }));
  return screen.getByRole("switch", { name: "Allow agent session navigation" });
};

// Deliver the same targeted renderer request that ProjectSessionRuntime emits.
const requestOpen = async (
  fixture: ReturnType<typeof renderAppShellNavigation>,
  input: JsonObject,
) =>
  act(async () =>
    fixture.root.applicationControlStore.handleProjectSessionRequest({
      sessionId: "alpha",
      controlRequestId: crypto.randomUUID(),
      invocation: { _tag: "InvokeAppControl", command: "sessions.open", input },
    }),
  );

describe("Agent session navigation workflow", () => {
  it("opens the target in the invoking window's focused pane, not the background caller's pane", async () => {
    const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
      async () => undefined,
    );
    using otherWindow = createRendererStoreFixture();
    using fixture = renderAppShellNavigation({ projectSessions: { respondControl } });
    await fixture.user.click(sessionButton("alpha"));
    await expectChat("alpha");
    await act(async () => {
      fixture.root.navigationStore.splitFocusedSession("x");
    });
    await fixture.user.click(sessionButton("gamma"));
    await expectChat("gamma");
    const focusedPane = fixture.root.sessionLayoutStore.focusedPaneId;
    await requestOpen(fixture, { sessionId: "beta" });
    await expectChat("beta");
    expect(document.querySelectorAll('[data-slot="session-pane"]')).toHaveLength(2);
    expect(fixture.root.sessionLayoutStore.paneForSession("beta")?.paneId).toBe(focusedPane);
    expect(fixture.root.sessionLayoutStore.paneForSession("alpha")).toBeDefined();
    expect(otherWindow.root.appShellStore.selection).toEqual({ kind: "workbench" });
    expect(respondControl).toHaveBeenCalledWith(
      "alpha",
      expect.any(String),
      { ok: true, command: "sessions.open", opened: { workspacePath: "/beta", sessionId: "beta" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["beta", CAKE_CHAT_SESSION_ID])(
    "opens an exact original outside the visible projection for %s without switching its Pi branch",
    async (sessionId) => {
      const ref = messageReference(sessionId, "original-entry");
      const inspect = vi.fn<Client["sessionChats"]["inspect"]>(async () => ({
        message: {
          ref,
          link: ref,
          sessionId,
          entryId: "original-entry",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          role: "user",
          active: false,
          inputRefs: [],
          hasImages: false,
        },
        text: "Exact original evidence",
        totalChars: 23,
        offset: 0,
        nextOffset: null,
        truncated: false,
      }));
      const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
        async () => undefined,
      );
      using fixture = renderAppShellNavigation({
        sessionChats: { inspect },
        projectSessions: { respondControl },
        electron: { setFullscreenSurfaceOpen: async () => undefined },
      });
      await requestOpen(fixture, { sessionId, messageId: "original-entry" });
      const dialog = await screen.findByRole("dialog", { name: "user · original-entry" });
      expect(dialog.textContent).toContain("Exact original evidence");
      expect(inspect).toHaveBeenCalledWith(
        {
          sessionId,
          kind: "messages-read",
          entryId: "original-entry",
          offset: 0,
          maxChars: 20_000,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(respondControl.mock.calls.at(-1)?.[2]).toMatchObject({
        ok: true,
        command: "sessions.open",
        opened: { sessionId, messageId: "original-entry" },
      });
      await fixture.user.click(
        screen.getByRole("button", { name: "Exit fullscreen user · original-entry" }),
      );
      expect(screen.queryByRole("dialog", { name: "user · original-entry" })).toBeNull();
    },
  );

  it.each(["text", "image"] as const)(
    "opens an exact %s attachment from its authorized session without an agent read",
    async (kind) => {
      const reference = {
        kind: "input" as const,
        id: "00000000-0000-4000-8000-000000000001",
        name: "Original input",
        mimeType: kind === "image" ? "image/png" : "text/plain",
        byteLength: 23,
      };
      const readAttachment = vi.fn<Client["sessionChats"]["readAttachment"]>(async () =>
        kind === "image"
          ? { kind, reference, data: "aW1hZ2U=", mimeType: "image/png" }
          : {
              kind,
              reference,
              text: "Exact attachment evidence",
              offset: 0,
              totalCharacters: 25,
              nextOffset: null,
            },
      );
      using fixture = renderAppShellNavigation({
        sessionChats: { readAttachment },
        electron: { setFullscreenSurfaceOpen: async () => undefined },
      });
      await act(async () =>
        fixture.root.navigationStore.openSessionLink(CAKE_CHAT_SESSION_ID, undefined, reference.id),
      );
      const dialog = await screen.findByRole("dialog", { name: "Original input" });
      if (kind === "text") expect(dialog.textContent).toContain("Exact attachment evidence");
      else
        expect(screen.getByRole("img", { name: "Original input" }).getAttribute("src")).toBe(
          "data:image/png;base64,aW1hZ2U=",
        );
      expect(readAttachment).toHaveBeenCalledWith(
        { sessionId: CAKE_CHAT_SESSION_ID, reference: reference.id, offset: 0, limit: 20_000 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByRole("button", { name: "Copy attachment link" })).toBeDefined();
      await fixture.user.click(
        screen.getByRole("button", { name: "Exit fullscreen Original input" }),
      );
      expect(screen.queryByRole("dialog", { name: "Original input" })).toBeNull();
    },
  );

  it.each(["missing", CAKE_CHAT_SESSION_ID, "", 42])(
    "rejects invalid Project Session target %s without navigating",
    async (sessionId) => {
      const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
      const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
        async () => undefined,
      );
      using fixture = renderAppShellNavigation({ projectSessions: { open, respondControl } });
      await fixture.user.click(sessionButton("alpha"));
      await expectChat("alpha");
      open.mockClear();
      await requestOpen(fixture, { sessionId });
      await expectChat("alpha");
      expect(open).not.toHaveBeenCalled();
      expect(respondControl).toHaveBeenCalledWith(
        "alpha",
        expect.any(String),
        expect.objectContaining({ ok: false, command: "sessions.open", error: expect.any(String) }),
        expect.anything(),
      );
    },
  );

  it("blocks Project Session and Cake Chat agents when disabled, while manual navigation stays available", async () => {
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
      async () => undefined,
    );
    using fixture = renderAppShellNavigation({ projectSessions: { open, respondControl } });
    await fixture.user.click(sessionButton("alpha"));
    const toggle = await openSettings(fixture);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await fixture.user.click(toggle);
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    open.mockClear();
    await requestOpen(fixture, { sessionId: "beta" });
    expect(respondControl).toHaveBeenCalledWith(
      "alpha",
      expect.any(String),
      expect.objectContaining({ ok: false, error: expect.stringContaining("disabled") }),
      expect.anything(),
    );
    await act(async () => {
      expect(
        await fixture.root.applicationControlStore.invoke(
          { name: "sessions.open", arguments: { sessionId: "gamma" } },
          { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
        ),
      ).toMatchObject({ ok: false, error: expect.stringContaining("disabled") });
    });
    await expectChat("alpha");
    expect(open).not.toHaveBeenCalled();

    await fixture.user.click(sessionButton("beta"));
    await expectChat("beta");
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("gamma");
    });
    await expectChat("gamma");
    await fixture.user.click(await openSettings(fixture));
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await requestOpen(fixture, { sessionId: "alpha" });
    await expectChat("alpha");
  });

  it("persists the user-only permission in window storage and restores it before agent requests", async () => {
    let saved: StoreSnapshot;
    {
      const save = vi.fn<Client["windowState"]["save"]>(async () => undefined);
      using fixture = renderAppShellNavigation({ windowState: { save } });
      using persistence = new WindowStatePersistence(fixture.client, (error) => {
        throw error;
      });
      persistence.observe(fixture.root);
      const toggle = await openSettings(fixture);
      await fixture.user.click(toggle);
      await persistence.flush();
      saved = toSnapshot(fixture.root);
      expect(save).toHaveBeenLastCalledWith(JSON.parse(JSON.stringify(saved)));
      expect(saved).toMatchObject({
        children: {
          settingsStore: { children: { agentNavigation: { state: { enabled: false } } } },
        },
      });
    }
    const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
      async () => undefined,
    );
    using restored = renderAppShellNavigation({ projectSessions: { respondControl } }, saved);
    expect((await openSettings(restored)).getAttribute("aria-checked")).toBe("false");
    await requestOpen(restored, { sessionId: "beta" });
    expect(respondControl.mock.calls.at(-1)?.[2]).toMatchObject({
      ok: false,
      error: expect.stringContaining("disabled"),
    });
    // No permission field is accepted by an agent-writable Settings section.
    await expect(
      restored.root.applicationControlStore.invoke({
        name: "settings.update",
        arguments: { section: "agentNavigation", changes: { enabled: true } },
      }),
    ).rejects.toThrow();
    expect(
      screen
        .getByRole("switch", { name: "Allow agent session navigation" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    using unrelatedWindow = createRendererStoreFixture();
    expect(unrelatedWindow.root.settingsStore.agentNavigation.enabled).toBe(true);
    expect(searchSettings("agent navigation").flatMap((page) => page.items)).toContainEqual(
      expect.objectContaining({ targetId: "setting-agent-session-navigation" }),
    );
  });
});
