/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
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
  vi.restoreAllMocks();
});

const settings = () => screen.getByRole("button", { name: "Settings" });
const openLibrary = async (user: ReturnType<typeof renderAppShellNavigation>["user"]) => {
  await user.click(
    within(screen.getByRole("navigation", { name: "Projects and global utilities" })).getByRole(
      "button",
      { name: "Artifacts" },
    ),
  );
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

async function selectProjectSession(
  fixture: ReturnType<typeof renderAppShellNavigation>,
  sessionId: string,
) {
  await fixture.selectSession(sessionId);
  await waitFor(() =>
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "project-session",
      sessionId,
    }),
  );
  await screen.findByRole("combobox", { name: "Message" });
}

// The artifact browser exposes the shell's conversation history; workbench Back/Forward
// first traverses pane-local history (covered by project-navigation/workbench workflows).
describe("App shell navigation workflow", () => {
  it("keeps Global Cake Chat as the sidebar library link target and honors an explicit caller", async () => {
    using fixture = renderAppShellNavigation();
    await fixture.user.click(cakeChatButton());
    await openLibrary(fixture.user);
    expect(fixture.root.artifactLibraryStore.activeSessionId).toBe(CAKE_CHAT_SESSION_ID);
    act(() => fixture.root.navigationStore.showArtifactLibrary("alpha"));
    expect(fixture.root.artifactLibraryStore.activeSessionId).toBe("alpha");
  });

  it.each(
    (["project-session", "project-chat"] as const).flatMap((initial) =>
      (["settings", "automations", "artifact-library"] as const).map((destination) => ({
        initial,
        destination,
      })),
    ),
  )(
    "leaves $initial for exclusive $destination and reselects only the requested project",
    async ({ initial, destination }) => {
      using fixture = renderAppShellNavigation();
      const global = toSnapshot(fixture.models.cakeChatCatalog).sessions![0]!;
      const projectChats = ["alpha", "beta"].map((name, index) => ({
        ...global,
        sessionId: `project-chat:${(index === 0 ? "a" : "b").repeat(64)}`,
        title: name,
        projectPath: `/${name}`,
      }));
      act(() =>
        applySnapshot(fixture.models.cakeChatCatalog, {
          loaded: true,
          sessions: [global, ...projectChats],
        }),
      );
      for (const chat of projectChats) {
        act(() => fixture.root.cakeChatCollectionStore.registry.load(chat.sessionId));
        await fixture.publishCakeChatProjection(chat.sessionId, [], "Snapshot");
      }
      const projectButton = (name: string) =>
        screen.getByRole("button", { name: `Open Project Chat for ${name}` });
      const expectProject = (name: string) => {
        expect(fixture.root.workspaceProjectPath).toBe(`/${name}`);
        expect(projectButton(name).getAttribute("aria-current")).toBe("page");
        expect(
          document.querySelectorAll('[data-slot="project-rail"] [aria-current="page"]'),
        ).toHaveLength(1);
      };
      if (initial === "project-session") await selectProjectSession(fixture, "alpha");
      else await fixture.user.click(projectButton("alpha"));
      expectProject("alpha");
      if (destination === "artifact-library") await openLibrary(fixture.user);
      else
        await fixture.user.click(
          screen.getByRole("button", {
            name: destination === "settings" ? "Settings" : "Automations",
          }),
        );

      expect(fixture.root.appShellStore.workspace).toBe(destination);
      expect(fixture.root.appShellStore.selection).toEqual({ kind: destination });
      expect(fixture.root.appShellStore.activeConversation).toBeUndefined();
      expect(fixture.root.workspaceProjectPath).toBeUndefined();
      expect(fixture.root.workspaceSession).toBeUndefined();
      expect(fixture.root.terminalStore.activeTarget).toBeUndefined();
      expect(
        document.querySelector('[data-slot="workspace"]')?.getAttribute("data-session-id"),
      ).toBeNull();
      expect(document.querySelector('[data-slot="session-pane"]')).toBeNull();
      expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
      expect(screen.queryByRole("navigation", { name: "Conversation breadcrumb" })).toBeNull();
      expect(
        document.querySelector('[aria-label^="Open Project Chat for"][aria-current="page"]'),
      ).toBeNull();
      if (destination === "artifact-library") {
        expect(fixture.root.artifactLibraryStore.activeSessionId).toBe(
          initial === "project-chat" ? projectChats[0]!.sessionId : "alpha",
        );
        expect(screen.getByRole("textbox", { name: "Search artifact library" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Artifacts" }).getAttribute("aria-current")).toBe(
          "page",
        );
        // Unlike full-window application views, the library keeps the rail reachable.
        await fixture.user.click(projectButton("beta"));
      } else {
        expect(
          screen.getByRole("heading", {
            name: destination === "settings" ? "Settings" : "Automations",
          }),
        ).toBeDefined();
        await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
        expectProject("alpha");
        await fixture.user.click(projectButton("beta"));
      }
      await waitFor(() => expectProject("beta"));
      expect(projectButton("alpha").getAttribute("aria-current")).toBeNull();
      expect(fixture.root.appShellStore.applicationSurface).toBeUndefined();
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(
        projectChats[1]!.sessionId,
      );
      await fixture.user.click(cakeChatButton());
      await expectCakeChat();
      expect(fixture.root.workspaceProjectPath).toBeUndefined();
      expect(cakeChatButton().getAttribute("aria-current")).toBe("page");
      expect(projectButton("beta").getAttribute("aria-current")).toBeNull();
    },
  );

  it("switches non-project routes without reactivating a retained project, then returns to it", async () => {
    using fixture = renderAppShellNavigation();
    await selectProjectSession(fixture, "alpha");
    // These public routing intents also serve callers outside the (hidden) project rail.
    for (const destination of [
      "settings",
      "automations",
      "artifact-library",
      "automations",
      "settings",
    ] as const) {
      act(() => {
        if (destination === "settings") fixture.root.navigationStore.showSettings();
        else if (destination === "automations") fixture.root.navigationStore.showAutomations();
        else fixture.root.navigationStore.showArtifactLibrary();
      });
      expect(fixture.root.appShellStore.selection).toEqual({ kind: destination });
      expect(fixture.root.appShellStore.activeConversation).toBeUndefined();
      expect(fixture.root.workspaceProjectPath).toBeUndefined();
      expect(fixture.root.workspaceSession).toBeUndefined();
      expect(document.querySelector('[data-slot="session-pane"]')).toBeNull();
    }
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "project-session",
      sessionId: "alpha",
    });
    expect(fixture.root.workspaceProjectPath).toBe("/alpha");
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it.each(
    (["project", "cake-chat"] as const).flatMap((workspace) =>
      (["settings", "artifact-library"] as const).map((cover) => ({ workspace, cover })),
    ),
  )(
    "starts global after $workspace under $cover, retaining explicit visit history",
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
        saved = toSnapshot(fixture.root) ?? {};
      }
      using restored = renderAppShellNavigation({}, { snapshot: saved });
      await expectCakeChat();
      expect(screen.queryByText("Model configuration")).toBeNull();
      expect(screen.queryByText("No artifacts match this view.")).toBeNull();
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

  it.each([false, true])(
    "resolving the selected Project Session opens its local Project Chat, not global or history (prior visit: %s)",
    async (priorVisit) => {
      const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => undefined);
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000001"),
      );
      using fixture = renderAppShellNavigation(
        { projectSessions: { resolve }, sessionChats: { prompt } },
        { transcriptViewport: true },
      );
      const localId = `project-chat:${"b".repeat(64)}`;
      act(() =>
        applySnapshot(fixture.models.cakeChatCatalog, {
          loaded: true,
          sessions: [
            ...(toSnapshot(fixture.models.cakeChatCatalog).sessions ?? []),
            {
              ...toSnapshot(fixture.models.cakeChatCatalog).sessions?.[0],
              sessionId: localId,
              title: "beta",
              projectPath: "/beta",
            },
          ],
        }),
      );
      const local = fixture.root.cakeChatCollectionStore.registry.load(localId);
      const global = fixture.root.cakeChatCollectionStore.registry.find(CAKE_CHAT_SESSION_ID)!;
      act(() => {
        global.conversationSessionStore.composerStore.draftStore.setText("Global draft");
        local.conversationSessionStore.composerStore.draftStore.setText("Project draft");
      });
      await fixture.publishCakeChatProjection(
        localId,
        [
          {
            id: "local-history",
            kind: "text",
            role: "assistant",
            text: "Local project history",
            status: "complete",
          },
        ],
        "Snapshot",
      );
      if (priorVisit) {
        await selectProjectSession(fixture, "alpha");
        await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Alpha draft");
      }
      await selectProjectSession(fixture, "beta");
      await fixture.showSessions();
      await fixture.user.click(screen.getByRole("button", { name: "Resolve beta conversation" }));
      await waitFor(() =>
        expect(fixture.root.appShellStore.activeConversation).toEqual({
          kind: "cake-chat",
          sessionId: localId,
        }),
      );
      expect(resolve).toHaveBeenCalledWith(
        { sessionId: "beta", workingDirectory: "/beta", userInitiated: true },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(
        within(screen.getByRole("navigation", { name: "Conversation breadcrumb" }))
          .getByRole("button", { name: "beta" })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe(localId);
      expect(cakeChatButton().getAttribute("aria-current")).not.toBe("page");
      expect(screen.queryByTestId("resolved-session-notice")).toBeNull();
      expect(await screen.findByText("Local project history")).toBeDefined();
      const composer = screen.getByRole("combobox", { name: "Message Project Chat" });
      expect(composer).toHaveProperty("value", "Project draft");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: localId, text: "Project draft" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(global.conversationSessionStore.composerStore.draftStore.text).toBe("Global draft");
      await fixture.publishResolved("beta");
      await selectProjectSession(fixture, "beta");
      expect(fixture.root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "beta",
      });
      expect(
        screen.getByRole("navigation", { name: "Conversation breadcrumb" }).textContent,
      ).toContain("beta conversation");
      expect(screen.getByTestId("resolved-session-notice")).toBeDefined();
      expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
      expect(resolve).toHaveBeenCalledOnce();
      if (priorVisit) {
        await selectProjectSession(fixture, "alpha");
        expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
          "value",
          "Alpha draft",
        );
      }
    },
  );

  it.each(["alpha", "cake-chat"])(
    "resolving a background session retains the current %s view and draft",
    async (view) => {
      const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => undefined);
      using fixture = renderAppShellNavigation({ projectSessions: { resolve } });
      await selectProjectSession(fixture, "beta");
      await selectProjectSession(fixture, "alpha");
      if (view === "cake-chat") await fixture.user.click(cakeChatButton());
      const composerName = view === "cake-chat" ? "Message Cake Chat" : "Message";
      await fixture.user.type(
        screen.getByRole("combobox", { name: composerName }),
        "Keep this draft",
      );
      const selected = fixture.root.appShellStore.activeConversation;
      await act(async () => fixture.root.sidebarStore.setSessionResolved("beta", true));
      await fixture.publishResolved("beta");
      expect(resolve).toHaveBeenCalledOnce();
      expect(fixture.root.appShellStore.activeConversation).toEqual(selected);
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe(selected?.sessionId);
      expect(screen.getByRole("combobox", { name: composerName })).toHaveProperty(
        "value",
        "Keep this draft",
      );
    },
  );

  it("keeps the viewed session and draft when manual resolution fails", async () => {
    const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => {
      throw new Error("Session is still running");
    });
    using fixture = renderAppShellNavigation({ projectSessions: { resolve } });
    await selectProjectSession(fixture, "beta");
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Keep my draft");
    await fixture.showSessions();
    await fixture.user.click(screen.getByRole("button", { name: "Resolve beta conversation" }));
    expect(await screen.findByText("Session is still running")).toBeDefined();
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "project-session",
      sessionId: "beta",
    });
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
      "value",
      "Keep my draft",
    );
  });

  it.each(["agent", "automatic"] as const)(
    "%s resolution retains the viewed session, pane, and draft",
    async (origin) => {
      const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => undefined);
      using fixture = renderAppShellNavigation({ projectSessions: { resolve } });
      await selectProjectSession(fixture, "beta");
      await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Keep my draft");
      const session = fixture.root.sessionRegistry.findSession("beta");
      if (origin === "agent") {
        await act(async () => {
          expect(
            await fixture.root.sessionRetirementStore.setProjectSessionsResolved(
              ["beta"],
              true,
              "agent",
            ),
          ).toBe(1);
        });
        expect(resolve).toHaveBeenCalledWith(
          { sessionId: "beta", workingDirectory: "/beta", userInitiated: false },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      }
      await fixture.publishResolved("beta");
      expect(fixture.root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "beta",
      });
      expect(fixture.root.sessionRegistry.findSession("beta")).toBe(session);
      expect(screen.getByTestId("resolved-session-notice")).toBeDefined();
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
        "value",
        "Keep my draft",
      );
    },
  );

  it("does not redirect a session opened while its background resolution was pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    using fixture = renderAppShellNavigation({ projectSessions: { resolve: () => pending } });
    await selectProjectSession(fixture, "alpha");
    let resolving!: Promise<boolean>;
    act(() => {
      resolving = fixture.root.sessionRetirementStore.setProjectSessionResolved("beta", true);
    });
    await selectProjectSession(fixture, "beta");
    await act(async () => {
      finish();
      await resolving;
    });
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "project-session",
      sessionId: "beta",
    });
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it("does not redirect navigation made while selected-session resolution is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    using fixture = renderAppShellNavigation({ projectSessions: { resolve: () => pending } });
    await selectProjectSession(fixture, "beta");
    let resolving!: Promise<boolean>;
    act(() => {
      resolving = fixture.root.sessionRetirementStore.setProjectSessionResolved("beta", true);
    });
    await selectProjectSession(fixture, "alpha");
    await act(async () => {
      finish();
      await resolving;
    });
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "project-session",
      sessionId: "alpha",
    });
    await expectProjectChat("alpha");
  });

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
      // Deliberately leave selection pending; the normal fixture helper waits for it to land.
      await fixture.user.click(screen.getByRole("button", { name: "Search sessions" }));
      await fixture.user.click(screen.getByRole("option", { name: /^alpha conversation / }));
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

  it("returns from global Settings and the artifact browser to the remembered project or Cake Chat", async () => {
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
    expect(screen.getByRole("heading", { name: "Settings" })).toBeDefined();
    expect(
      screen.getByText(
        "Open a project or start a one-off chat to choose a model and reasoning level.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Model configuration")).toBeNull();
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
    // Reopen through the persistent rail; switching global destinations preserves
    // return memory, not current selection.
    await openLibrary(fixture.user);
    await fixture.user.click(settings());
    expect(screen.getByRole("heading", { name: "Settings" })).toBeDefined();
    expect(
      screen.getByText(
        "Open a project or start a one-off chat to choose a model and reasoning level.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Model configuration")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectProjectChat("alpha");

    await fixture.user.click(cakeChatButton());
    await fixture.user.click(settings());
    expect(screen.getByRole("heading", { name: "Settings" })).toBeDefined();
    expect(
      screen.getByText(
        "Open a project or start a one-off chat to choose a model and reasoning level.",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Model configuration")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
    await expectCakeChat();
  });
});
