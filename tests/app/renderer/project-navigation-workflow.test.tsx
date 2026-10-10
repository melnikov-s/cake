/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/ipc/cake-chat-data";
import { defaultApplicationState } from "../../../src/services/storage/application-data";
import type { ConversationSnapshot } from "../../../src/ipc/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { defaultHotkeyBinding } from "../../../src/renderer/lib/hotkeys";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projects = ["alpha", "beta", "gamma"].map((name) =>
  projectRecord({ path: `/${name}`, name }),
);
const sessions = ["alpha", "beta"].map((name) =>
  sessionSummary({ sessionId: name, title: `${name} session`, projectPath: `/${name}` }),
);
function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function renderNavigation(
  open: Client["projectSessions"]["open"] = async () => undefined,
  navigationSessions = sessions,
) {
  const fixture = createRendererStoreFixture({
    projects,
    sessions: navigationSessions,
    client: {
      projectSessions: { open },
      cakeChats: { open: async () => undefined },
      electron: { chooseProject: async () => "/beta" },
      workspaces: {
        inspect: async (request) => ({ ...request, trustRequired: false }),
        registerProject: async () => defaultApplicationState(),
        loadStagedSlashCommands: async () => [],
      },
    },
  });
  let revision = 0;
  const publish = (id: string, streaming = false) =>
    applyConversationUpdate(
      fixture.models.projectConversation(
        id,
        navigationSessions.find((session) => session.sessionId === id)!.workingDirectory,
      ),
      {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: { ...snapshot(id), streaming },
      },
    );
  fixture.root.sessionRegistry.load("alpha", "/alpha");
  publish("alpha");
  fixture.root.appShellStore.selectProjectSession("alpha");
  fixture.root.projectWorkbenchStore.showLoadedSession("alpha");
  fixture.root.sessionLayoutStore.ensureSession("alpha");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    async hydrate(id: string) {
      await act(async () => publish(id));
    },
    async failHydration(id: string, message: string) {
      await act(async () => {
        const summary = navigationSessions.find((session) => session.sessionId === id)!;
        fixture.models.projectConversation(id, summary.workingDirectory).observationError = message;
      });
    },
    async publishActivity(activeIds: readonly string[]) {
      await act(async () => {
        for (const session of navigationSessions) {
          fixture.root.sessionRegistry.load(session.sessionId, session.workingDirectory);
          publish(session.sessionId, activeIds.includes(session.sessionId));
        }
      });
    },
    async publishCakeChatActivity(streaming: boolean) {
      await act(async () => {
        applySnapshot(fixture.models.cakeChatCatalog, {
          loaded: true,
          sessions: [
            sessionSummary({
              sessionId: CAKE_CHAT_SESSION_ID,
              projectPath: "/",
              title: "Cake Chat",
            }),
          ],
        });
        fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
        applyConversationUpdate(fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID), {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot: { ...snapshot(CAKE_CHAT_SESSION_ID), streaming },
        });
      });
    },
    async changeActivity() {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: sessions.map((session) => ({
            ...session,
            modifiedAt:
              session.sessionId === "beta" ? "2026-02-01T00:00:00.000Z" : session.modifiedAt,
          })),
          resolvedHasMoreByProject: {},
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
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
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.unstubAllGlobals();
});

// Supplementary workflow proof; real shifted key input is verified in Electron.
function pressActiveSessionShortcut(direction: "next" | "previous") {
  const binding = defaultHotkeyBinding(
    direction === "next" ? "next-active-session" : "previous-active-session",
  );
  const mac = binding.startsWith("Mod+");
  fireEvent.keyDown(window, {
    key: mac
      ? direction === "next"
        ? "}"
        : "{"
      : direction === "next"
        ? "ArrowRight"
        : "ArrowLeft",
    code: mac
      ? direction === "next"
        ? "BracketRight"
        : "BracketLeft"
      : direction === "next"
        ? "ArrowRight"
        : "ArrowLeft",
    metaKey: mac,
    altKey: !mac,
    shiftKey: true,
  });
}

describe("Project navigation workflow", () => {
  it("cycles working sessions across projects in both directions, wraps, and skips sessions as they finish", async () => {
    const navigationSessions = [
      sessions[0]!,
      sessionSummary({ sessionId: "idle", projectPath: "/alpha", unread: true }),
      sessionSummary({
        sessionId: "second",
        projectPath: "/alpha",
        modifiedAt: "2025-01-01T00:00:00.000Z",
      }),
      sessions[1]!,
    ];
    using fixture = renderNavigation(undefined, navigationSessions);
    await fixture.publishActivity(["alpha", "second", "beta"]);
    pressActiveSessionShortcut("next");
    await waitFor(() =>
      expect(document.querySelector(".session-item.active")?.getAttribute("data-session-id")).toBe(
        "second",
      ),
    );
    pressActiveSessionShortcut("next");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe("beta"),
    );
    pressActiveSessionShortcut("next");
    await waitFor(() =>
      expect(document.querySelector(".session-item.active")?.getAttribute("data-session-id")).toBe(
        "alpha",
      ),
    );
    pressActiveSessionShortcut("previous");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe("beta"),
    );
    await fixture.publishActivity(["alpha", "second"]);
    pressActiveSessionShortcut("previous");
    await waitFor(() =>
      expect(document.querySelector(".session-item.active")?.getAttribute("data-session-id")).toBe(
        "second",
      ),
    );
    await fixture.publishActivity([]);
    pressActiveSessionShortcut("next");
    pressActiveSessionShortcut("previous");
    expect(document.querySelector(".session-item.active")?.getAttribute("data-session-id")).toBe(
      "second",
    );
  });

  it("cycles only working sessions in the focused project, wraps, and restores global scope on exit", async () => {
    using fixture = renderNavigation(undefined, [
      sessions[0]!,
      sessionSummary({ sessionId: "idle", projectPath: "/alpha", unread: true }),
      sessionSummary({
        sessionId: "second",
        title: "Second alpha session",
        projectPath: "/alpha",
        workingDirectory: "/alpha-worktree",
        modifiedAt: "2025-01-01T00:00:00.000Z",
      }),
      sessions[1]!,
    ]);
    await fixture.publishActivity(["alpha", "second", "beta"]);
    await fixture.publishCakeChatActivity(true);
    await fixture.user.click(screen.getByRole("button", { name: "Focus on alpha" }));
    const pane = () =>
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id");
    pressActiveSessionShortcut("next");
    await waitFor(() => expect(pane()).toBe("second"));
    pressActiveSessionShortcut("next");
    await waitFor(() => expect(pane()).toBe("alpha"));
    pressActiveSessionShortcut("previous");
    await waitFor(() => expect(pane()).toBe("second"));
    await fixture.publishActivity(["alpha", "beta"]);
    pressActiveSessionShortcut("next");
    await waitFor(() => expect(pane()).toBe("alpha"));
    pressActiveSessionShortcut("previous");
    expect(pane()).toBe("alpha");
    await fixture.publishActivity(["beta"]);
    pressActiveSessionShortcut("next");
    pressActiveSessionShortcut("previous");
    expect(pane()).toBe("alpha");
    await fixture.user.click(screen.getByRole("button", { name: "Exit focus mode for alpha" }));
    pressActiveSessionShortcut("next");
    await waitFor(() => expect(pane()).toBe("beta"));
    pressActiveSessionShortcut("next");
    expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
  });

  it("enters the focused project's working sessions when the selection belongs to another project", async () => {
    using fixture = renderNavigation();
    await fixture.publishActivity(["alpha", "beta"]);
    await fixture.publishCakeChatActivity(true);
    await fixture.user.click(screen.getByRole("button", { name: "Focus on beta" }));
    pressActiveSessionShortcut("previous");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe("beta"),
    );
    pressActiveSessionShortcut("next");
    pressActiveSessionShortcut("previous");
    expect(
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
    ).toBe("beta");
  });

  it("filters both history directions by project without changing the selection when focus starts", async () => {
    using fixture = renderNavigation(undefined, [
      ...sessions,
      sessionSummary({
        sessionId: "second",
        title: "Second alpha session",
        projectPath: "/alpha",
        workingDirectory: "/alpha-worktree",
      }),
    ]);
    await fixture.publishActivity([]);
    await fixture.publishCakeChatActivity(false);
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    await fixture.user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await fixture.user.click(screen.getByRole("button", { name: /^Second alpha session / }));
    await fixture.user.click(screen.getByRole("button", { name: "Focus on alpha" }));
    const pane = () =>
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id");
    const back = screen.getByRole("button", { name: "Go back in session history" });
    const forward = screen.getByRole("button", { name: "Go forward in session history" });
    expect(pane()).toBe("second");
    await fixture.user.click(back);
    await waitFor(() => expect(pane()).toBe("alpha"));
    expect(back.hasAttribute("disabled")).toBe(true);
    await fixture.user.click(forward);
    await waitFor(() => expect(pane()).toBe("second"));
    expect(forward.hasAttribute("disabled")).toBe(true);
    await fixture.user.click(back);
    await waitFor(() => expect(pane()).toBe("alpha"));
    await fixture.user.click(screen.getByRole("button", { name: "Exit focus mode for alpha" }));
    await fixture.user.click(screen.getByRole("button", { name: "Focus on beta" }));
    expect(pane()).toBe("alpha");
    expect(back.hasAttribute("disabled")).toBe(true);
    await fixture.user.click(forward);
    await waitFor(() => expect(pane()).toBe("beta"));
    expect(forward.hasAttribute("disabled")).toBe(true);
  });

  it("reaches a running child inside a collapsed family instead of its idle parent", async () => {
    using fixture = renderNavigation(undefined, [
      sessionSummary({ ...sessions[0]!, familyChildSessionIds: ["child"] }),
      sessionSummary({
        sessionId: "child",
        projectPath: "/alpha",
        familyParentSessionId: "alpha",
        familyDepth: 1,
        familyChildOrder: 0,
      }),
      sessions[1]!,
    ]);
    await fixture.publishActivity(["child"]);
    await fixture.user.click(
      screen.getByRole("button", { name: "Collapse children of alpha session" }),
    );
    pressActiveSessionShortcut("next");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe("child"),
    );
    pressActiveSessionShortcut("previous");
    expect(
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
    ).toBe("child");
  });

  it("includes Cake Chat in active-session cycling while it is working", async () => {
    using fixture = renderNavigation();
    await fixture.publishActivity(["alpha", "beta"]);
    await fixture.publishCakeChatActivity(true);
    pressActiveSessionShortcut("previous");
    expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
    pressActiveSessionShortcut("previous");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe("beta"),
    );
    await fixture.publishCakeChatActivity(false);
    pressActiveSessionShortcut("next");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
      ).toBe("alpha"),
    );
  });

  it("selects the existing session when reopening a registered project", async () => {
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderNavigation(open);
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        { sessionId: "beta", workingDirectory: "/beta" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.hydrate("beta");
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    expect(screen.getAllByText("beta session").length).toBeGreaterThan(1);
  });
  it("keeps the current conversation until the requested session hydrates and supports returning to a cached session", async () => {
    const opening = deferred<void>();
    const open = vi.fn<Client["projectSessions"]["open"]>(() => opening.promise);
    using fixture = renderNavigation(open);
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(open).toHaveBeenCalledWith(
      { sessionId: "beta", workingDirectory: "/beta" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await act(async () => opening.resolve());
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.hydrate("beta");
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Go back in session history" }));
    expect(await screen.findByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    const calls = open.mock.calls.length;
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(open).toHaveBeenCalledTimes(calls);
  });

  it("starts session processing before fading out and stays blank until hydration", async () => {
    const operations: string[] = [];
    const opening = deferred<void>();
    const open = vi.fn<Client["projectSessions"]["open"]>(() => {
      operations.push("open");
      return opening.promise;
    });
    using fixture = renderNavigation(open);
    const matchMedia = window.matchMedia;
    vi.stubGlobal("matchMedia", (query: string) => ({ ...matchMedia(query), matches: false }));
    let exit: Animation | undefined;
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: function (this: HTMLElement) {
        const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
        if (this.dataset.slot === "content-transition-outgoing") {
          operations.push("fade-out");
          exit = animation;
        } else if (this.dataset.slot === "content-transition-live") {
          operations.push("fade-in");
        }
        return animation;
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(operations).toEqual(["open", "fade-out"]);
    await act(async () => exit!.onfinish?.call(exit!, {} as AnimationPlaybackEvent));
    const live = document.querySelector<HTMLElement>('[data-slot="content-transition-live"]')!;
    expect(live.classList.contains("opacity-0")).toBe(true);
    await act(async () => opening.resolve());
    expect(operations).toEqual(["open", "fade-out"]);
    expect(live.classList.contains("opacity-0")).toBe(true);
    await fixture.hydrate("beta");
    await waitFor(() => expect(operations).toEqual(["open", "fade-out", "fade-in"]));
    expect(live.classList.contains("opacity-0")).toBe(false);
    expect(screen.getByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
  });

  it("restores the outgoing chat after a hydration failure, reports it, and lets the user retry", async () => {
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderNavigation(open);
    const matchMedia = window.matchMedia;
    vi.stubGlobal("matchMedia", (query: string) => ({ ...matchMedia(query), matches: false }));
    let exit: Animation | undefined;
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: function (this: HTMLElement) {
        const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
        if (this.dataset.slot === "content-transition-outgoing") exit = animation;
        return animation;
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    await act(async () => exit!.onfinish?.call(exit!, {} as AnimationPlaybackEvent));
    const live = document.querySelector<HTMLElement>('[data-slot="content-transition-live"]')!;
    expect(live.classList.contains("opacity-0")).toBe(true);
    await fixture.failHydration("beta", "That session is no longer available");
    await screen.findByText("That session is no longer available");
    expect(live.classList.contains("opacity-0")).toBe(false);
    expect(live.inert).toBe(false);
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    await act(async () => exit!.onfinish?.call(exit!, {} as AnimationPlaybackEvent));
    await fixture.hydrate("beta");
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
    expect(live.classList.contains("opacity-0")).toBe(false);
  });

  it("retains the current project after an open failure and lets the user retry", async () => {
    const open = vi
      .fn<Client["projectSessions"]["open"]>()
      .mockRejectedValueOnce(new Error("Session temporarily unavailable"))
      .mockResolvedValue(undefined);
    using fixture = renderNavigation(open);
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^beta session / }));
    await fixture.hydrate("beta");
    expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("focuses the sidebar on a project without replacing the active conversation", async () => {
    using fixture = renderNavigation();
    await fixture.user.click(screen.getByRole("button", { name: "Focus on beta" }));
    expect(screen.queryByRole("button", { name: /^alpha session / })).toBeNull();
    expect(screen.getByRole("button", { name: /^beta session / })).toBeDefined();
    expect(screen.getByPlaceholderText("Ask Cake to work in alpha…")).toBeDefined();
  });

  it("reorders projects through drag and drop and retains that order when activity changes", async () => {
    using fixture = renderNavigation();
    const source = screen.getByRole("button", { name: "Start new chat in alpha" });
    const target = screen.getByRole("button", { name: "Start new chat in gamma" });
    const payload = new Map<string, string>();
    const dataTransfer = {
      types: ["application/x-cake-item"],
      setData: (type: string, value: string) => payload.set(type, value),
      getData: (type: string) => payload.get(type) ?? "",
    };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(target, { dataTransfer, clientY: 10 });
    fireEvent.dragEnd(source, { dataTransfer });
    const projectButtons = () =>
      screen
        .getAllByRole("button", { name: /^Collapse (alpha|beta|gamma)$/ })
        .map((button) => button.getAttribute("aria-label"));
    expect(projectButtons()).toEqual(["Collapse beta", "Collapse gamma", "Collapse alpha"]);
    await fixture.changeActivity();
    expect(projectButtons()).toEqual(["Collapse beta", "Collapse gamma", "Collapse alpha"]);
  });

  it("keeps project order stable when activity changes", async () => {
    using fixture = renderNavigation();
    const projectButtons = () =>
      screen
        .getAllByRole("button", { name: /^Collapse (alpha|beta|gamma)$/ })
        .map((button) => button.getAttribute("aria-label"));
    expect(projectButtons()).toEqual(["Collapse alpha", "Collapse beta", "Collapse gamma"]);
    await fixture.changeActivity();
    expect(projectButtons()).toEqual(["Collapse alpha", "Collapse beta", "Collapse gamma"]);
  });
});
