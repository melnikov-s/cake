/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

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

const settings = () => screen.getByRole("button", { name: "Settings" });
const openLibrary = async (user: ReturnType<typeof renderAppShellNavigation>["user"]) => {
  if (!screen.queryByRole("button", { name: "Browse all artifacts" })) {
    await user.click(
      within(screen.getByRole("navigation", { name: "Projects and global utilities" })).getByRole(
        "button",
        { name: /^(?:\d+ artifacts|Artifacts)$/ },
      ),
    );
  }
  await user.click(await screen.findByRole("button", { name: "Browse all artifacts" }));
};
const sessionButton = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name} conversation `) });
const cakeChatButton = () => screen.getByRole("button", { name: "Open Cake Chat" });
const expectProjectChat = async (name: string) => {
  expect(await screen.findByPlaceholderText(`Ask Cake to work in ${name}…`)).toBeDefined();
};
const expectCakeChat = async () => {
  expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
};

// The artifact browser exposes the shell's conversation history; workbench Back/Forward
// first traverses pane-local history (covered by project-navigation/workbench workflows).
describe("App shell navigation workflow", () => {
  it.each(
    (["project", "cake-chat"] as const).flatMap((workspace) =>
      (["settings", "artifact-library"] as const).map((cover) => ({ workspace, cover })),
    ),
  )(
    "persisted-window restore keeps $workspace under its $cover cover",
    async ({ workspace, cover }) => {
      let saved: StoreSnapshot;
      {
        using fixture = renderAppShellNavigation();
        await fixture.selectSession("alpha");
        await expectProjectChat("alpha");
        await fixture.selectSession("beta");
        await expectProjectChat("beta");
        if (workspace === "cake-chat") {
          await fixture.user.click(cakeChatButton());
          await expectCakeChat();
        }
        if (cover === "settings") await fixture.user.click(settings());
        else await openLibrary(fixture.user);
        saved = toSnapshot(fixture.root);
      }
      using restored = renderAppShellNavigation({}, { snapshot: saved });
      if (cover === "settings") {
        expect(await screen.findByText("Model configuration")).toBeDefined();
        await restored.user.click(screen.getByRole("button", { name: "Back to chat" }));
      } else {
        expect(await screen.findByText("No artifacts match this view.")).toBeDefined();
        await restored.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
      }
      if (workspace === "cake-chat") await expectCakeChat();
      else await expectProjectChat("beta");
      // Window visits survive covering/restoration without becoming pane-local history.
      await openLibrary(restored.user);
      await restored.pressHistory("back");
      await expectProjectChat(workspace === "cake-chat" ? "beta" : "alpha");
      await openLibrary(restored.user);
      await restored.pressHistory("forward");
      if (workspace === "cake-chat") await expectCakeChat();
      else await expectProjectChat("beta");
    },
  );

  it("traverses project and Cake Chat visits without recording reselections and truncates a divergent forward branch", async () => {
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderAppShellNavigation({ projectSessions: { open } });
    expect(fixture.root.appShellStore.canGoBack).toBe(false);
    expect(fixture.root.appShellStore.canGoForward).toBe(false);
    await fixture.selectSession("alpha");
    await expectProjectChat("alpha");
    await fixture.selectSession("alpha");
    await expectProjectChat("alpha");
    await fixture.user.click(cakeChatButton());
    await expectCakeChat();
    await fixture.user.click(cakeChatButton());
    await openLibrary(fixture.user);
    await fixture.pressHistory("back");
    await expectProjectChat("alpha");
    expect(fixture.root.appShellStore.canGoBack).toBe(false);
    expect(fixture.root.appShellStore.canGoForward).toBe(true);
    await openLibrary(fixture.user);
    await fixture.pressHistory("forward");
    await expectCakeChat();
    expect(fixture.root.appShellStore.canGoForward).toBe(false);

    await fixture.selectSession("beta");
    await expectProjectChat("beta");
    await openLibrary(fixture.user);
    await fixture.pressHistory("back");
    await expectCakeChat();
    await fixture.selectSession("gamma");
    await expectProjectChat("gamma");
    expect(fixture.root.appShellStore.canGoForward).toBe(false);
    await openLibrary(fixture.user);
    await fixture.pressHistory("back");
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.pressHistory("forward");
    await expectProjectChat("gamma");

    // Selecting an earlier visited session directly is a new visit, not a traversal.
    await fixture.selectSession("alpha");
    await expectProjectChat("alpha");
    expect(fixture.root.appShellStore.canGoForward).toBe(false);
    await openLibrary(fixture.user);
    await fixture.pressHistory("back");
    await expectProjectChat("gamma");
    expect(open).toHaveBeenCalledWith(
      { sessionId: "gamma", workingDirectory: "/gamma" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("skips newly resolved project visits in both directions but retains the permanent Cake Chat", async () => {
    using fixture = renderAppShellNavigation();
    await fixture.selectSession("alpha");
    await expectProjectChat("alpha");
    await fixture.selectSession("beta");
    await expectProjectChat("beta");
    await fixture.user.click(cakeChatButton());
    await fixture.selectSession("gamma");
    await expectProjectChat("gamma");
    await fixture.publishResolved("beta");
    await openLibrary(fixture.user);
    await fixture.pressHistory("back");
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.pressHistory("back");
    await expectProjectChat("alpha");
    expect(fixture.root.appShellStore.canGoBack).toBe(false);
    await openLibrary(fixture.user);
    await fixture.pressHistory("forward");
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.pressHistory("forward");
    await expectProjectChat("gamma");
    expect(fixture.root.appShellStore.canGoForward).toBe(false);
  });

  it("keeps an archived preview out of history until restoration is published", async () => {
    const restore = vi.fn<Client["projectSessions"]["restore"]>(async () => undefined);
    using fixture = renderAppShellNavigation(
      { projectSessions: { restore } },
      { resolvedIds: ["beta"] },
    );
    await fixture.selectSession("alpha");
    await expectProjectChat("alpha");
    await fixture.selectSession("beta");
    await expectProjectChat("beta");
    expect(fixture.root.appShellStore.canGoBack).toBe(false);
    expect(fixture.root.appShellStore.canGoForward).toBe(false);
    await fixture.showSessions(true);
    await fixture.user.click(screen.getByRole("button", { name: "Restore beta conversation" }));
    expect(restore).toHaveBeenCalledWith(
      { sessionId: "beta", workingDirectory: "/beta", userInitiated: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Successful RPC alone must not promote an archived preview.
    expect(fixture.root.appShellStore.canGoBack).toBe(false);
    await fixture.publishResolved("beta", false);
    await openLibrary(fixture.user);
    await fixture.pressHistory("back");
    await expectProjectChat("alpha");
    expect(fixture.root.appShellStore.canGoBack).toBe(false);
    await openLibrary(fixture.user);
    await fixture.pressHistory("forward");
    await expectProjectChat("beta");
    expect(fixture.root.appShellStore.canGoForward).toBe(false);
  });

  it("deletes an archived preview and returns to the retained visit without recording the preview", async () => {
    const deleteSession = vi.fn<Client["workspaces"]["deleteSession"]>(async (sessionId) => {
      await fixture.publishRemoved(sessionId);
      return defaultApplicationState();
    });
    using fixture = renderAppShellNavigation(
      {
        electron: { showSessionContextMenu: async () => ({ action: "delete" }) },
        workspaces: { deleteSession },
      },
      { resolvedIds: ["beta"] },
    );
    await fixture.selectSession("alpha");
    await expectProjectChat("alpha");
    await fixture.selectSession("beta");
    await expectProjectChat("beta");
    await fixture.showSessions(true);
    await fixture.user.pointer({ target: sessionButton("beta"), keys: "[MouseRight]" });
    await waitFor(() =>
      expect(deleteSession).toHaveBeenCalledWith(
        "beta",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await expectProjectChat("alpha");
    expect(fixture.root.appShellStore.canGoBack).toBe(false);
    expect(fixture.root.appShellStore.canGoForward).toBe(false);
  });

  it.each([false, true])(
    "a pending cached selection respects a newer Settings intent (open Settings: %s)",
    async (showSettings) => {
      using fixture = renderAppShellNavigation({}, { history: ["beta"] });
      const frames = new Map<number, FrameRequestCallback>();
      let frameId = 0;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
      await fixture.selectSession("alpha");
      expect(screen.getByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
      expect(frames.size).toBeGreaterThan(0);
      if (showSettings) {
        await fixture.user.click(settings());
        expect(screen.getByRole("button", { name: /^Agent Behavior and content$/ })).toBeDefined();
      }
      // Complete the held native-focus/selection boundary, not an elapsed sleep.
      const pending = [...frames.values()];
      frames.clear();
      await act(async () => pending.forEach((frame) => frame(0)));
      if (showSettings) {
        expect(screen.getByRole("button", { name: /^Agent Behavior and content$/ })).toBeDefined();
        await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
        await expectProjectChat("beta");
      } else await expectProjectChat("alpha");
      expect(fixture.root.projectWorkbenchStore.openingSession).toBeUndefined();
    },
  );

  it.each([false, true])(
    "commits history only when a deferred destination lands and discards a superseded traversal (diverge: %s)",
    async (diverge) => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const open = vi.fn<Client["projectSessions"]["open"]>((request) =>
        request.sessionId === "beta" ? pending : Promise.resolve(),
      );
      using fixture = renderAppShellNavigation(
        { projectSessions: { open } },
        { history: ["alpha", "beta", "gamma"], unhydratedIds: ["beta"] },
      );
      await openLibrary(fixture.user);
      await fixture.pressHistory("back");
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          { sessionId: "beta", workingDirectory: "/beta" },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(fixture.root.appShellStore.canGoForward).toBe(false);
      if (diverge) {
        await fixture.selectSession("alpha");
        await expectProjectChat("alpha");
      }
      await act(async () => finish());
      await fixture.publishHydrated("beta");
      await expectProjectChat(diverge ? "alpha" : "beta");
      expect(fixture.root.appShellStore.canGoForward).toBe(!diverge);
      await openLibrary(fixture.user);
      await fixture.pressHistory(diverge ? "back" : "forward");
      await expectProjectChat("gamma");
      expect(fixture.root.appShellStore.canGoForward).toBe(diverge);
    },
  );

  it("returns from Settings and the artifact browser to the same project or Cake Chat and retains current-chat settings", async () => {
    const catalog = vi.fn<Client["artifacts"]["catalog"]>(async (request) => ({
      offset: request.offset ?? 0,
      limit: request.limit ?? 50,
      items: [],
      total: 0,
      hasMore: false,
    }));
    using fixture = renderAppShellNavigation({ artifacts: { catalog } });
    await fixture.selectSession("alpha");
    await expectProjectChat("alpha");
    await fixture.user.click(settings());
    expect(await screen.findByText("Model configuration")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectProjectChat("alpha");
    await openLibrary(fixture.user);
    expect(await screen.findByText("No artifacts match this view.")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Search artifact library" })).toBeDefined();
    expect(catalog).toHaveBeenCalledWith(
      { search: "", offset: 0, limit: 50 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
    await expectProjectChat("alpha");
    // The artifact popover closes when browsing; reopen it from the same session.
    await openLibrary(fixture.user);
    await fixture.user.click(settings());
    expect(await screen.findByText("Model configuration")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectProjectChat("alpha");

    await fixture.user.click(cakeChatButton());
    await fixture.user.click(settings());
    expect(await screen.findByText("Model configuration")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
    await expectCakeChat();
  });
});
