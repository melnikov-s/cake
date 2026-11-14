/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { startupSnapshot } from "../../../src/renderer/bootstrap/startup-snapshot";
import type { Client } from "../../../src/renderer/client/Client";
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

const projectChatId = `project-chat:${"a".repeat(64)}`;
const sideChatId = `${CAKE_CHAT_SESSION_ID}:side-chat:42`;
const node = (
  state: StoreSnapshot["state"] = {},
  children: StoreSnapshot["children"] = {},
): StoreSnapshot => ({ state, children });
const draft = node(
  {},
  {
    composerStore: node(
      {},
      {
        draftStore: node({
          text: "Only for alpha",
          attachments: [{ kind: "file", name: "notes.txt", path: "/alpha/notes.txt" }],
        }),
      },
    ),
  },
);
function savedDestination(sessionId: string, presentationMode = "normal"): StoreSnapshot {
  return node(
    {},
    {
      workspaceNavigatorStore: node({
        mode: "sessions",
        accessoryVisible: false,
        width: 376,
        companionTab: "sessions",
      }),
      appShellStore: node({
        navigationVersion: 4,
        workspace:
          sessionId === "alpha" || sessionId === projectChatId ? "project-sessions" : "cake-chat",
        coveringSurface: undefined,
        lastInteractedConversation: { kind: "project-session", sessionId: "alpha" },
      }),
      sessionLayoutStore: node({
        history: ["alpha", projectChatId],
        historyCursor: sessionId === projectChatId ? 1 : 0,
      }),
      sessionRegistry: node(
        { targets: [{ sessionId: "alpha", workspacePath: "/alpha" }] },
        {
          sessions: [
            { key: "alpha", ...node({ presentationMode }, { conversationSessionStore: draft }) },
          ],
        },
      ),
      cakeChatCollectionStore: node(
        {},
        {
          sessionLayoutStore: node({ history: [sessionId], historyCursor: 0 }),
          registry: node(
            { targets: [CAKE_CHAT_SESSION_ID] },
            {
              sessions: [{ key: CAKE_CHAT_SESSION_ID, ...node({ presentationMode }) }],
            },
          ),
        },
      ),
    },
  );
}
const globalComposer = () => screen.getByRole("combobox", { name: "Message Cake Chat" });

describe("unconditional global startup navigation", () => {
  it.each([
    ["regular session", "alpha", "normal"],
    ["Project Chat", projectChatId, "normal"],
    ["side chat", sideChatId, "normal"],
    ["editor", "alpha", "vscode"],
    ["browser", "alpha", "browser"],
    ["global editor", CAKE_CHAT_SESSION_ID, "vscode"],
    ["global browser", CAKE_CHAT_SESSION_ID, "browser"],
  ])(
    "launches global after %s, with send bound to global and the old draft intact",
    async (_label, sessionId, mode) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make("10000000-0000-4000-8000-000000000001"),
      );
      const openProject = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
      const saved = savedDestination(sessionId!, mode);
      const before = structuredClone(saved);
      using fixture = renderAppShellNavigation(
        { sessionChats: { prompt }, projectSessions: { open: openProject } },
        { snapshot: saved },
      );
      // The first rendered composer is already bound to the global conversation.
      expect(globalComposer()).toHaveProperty("value", "");
      expect(fixture.root.workspaceNavigatorStore.mode).toBe("todos");
      expect(fixture.root.workspaceNavigatorStore.visible).toBe(true);
      expect(fixture.root.workspaceNavigatorStore.chatWidth).toBe(376);
      expect(screen.getByRole("button", { name: /^To-dos / }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(screen.queryByRole("region", { name: "VS Code workspace" })).toBeNull();
      expect(screen.queryByPlaceholderText("Ask Cake to work in alpha…")).toBeNull();
      await act(async () => fixture.root.initialize());
      expect(prompt).not.toHaveBeenCalled();
      expect(openProject).not.toHaveBeenCalled();
      await fixture.user.type(globalComposer(), "This belongs to global");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(prompt.mock.calls[0]![0]).toMatchObject({
        sessionId: CAKE_CHAT_SESSION_ID,
        text: "This belongs to global",
        attachments: [],
      });
      await fixture.selectSession("alpha");
      expect(await screen.findByPlaceholderText("Ask Cake to work in alpha…")).toHaveProperty(
        "value",
        "Only for alpha",
      );
      expect(screen.getByText("notes.txt")).toBeDefined();
      expect(saved).toEqual(before);
    },
  );

  it.each([false, true])(
    "late hydration cannot replace startup or explicit navigation (navigated: %s)",
    async (navigated) => {
      using fixture = renderAppShellNavigation(
        {},
        { snapshot: savedDestination(projectChatId), cakeChatCatalogLoaded: false },
      );
      expect(globalComposer()).toBeDefined();
      if (navigated) {
        act(() => fixture.root.workspaceNavigatorStore.show("sessions"));
        await fixture.selectSession("beta");
        expect(await screen.findByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
      }
      await act(async () => {
        applySnapshot(fixture.models.cakeChatCatalog, {
          loaded: true,
          sessions: fixture.models.cakeChatCatalog.sessions.map((session) => toSnapshot(session)),
        });
        await fixture.root.sessionRegistry.pendingSessions.refreshSavedDrafts();
        await fixture.root.initialize();
        await fixture.root.cakeChatCollectionStore.initialize();
      });
      if (navigated) {
        expect(screen.getByPlaceholderText("Ask Cake to work in beta…")).toBeDefined();
        expect(fixture.root.workspaceNavigatorStore.mode).toBe("sessions");
      } else expect(globalComposer()).toBeDefined();
      await fixture.selectSession("alpha");
      expect(await screen.findByPlaceholderText("Ask Cake to work in alpha…")).toHaveProperty(
        "value",
        "Only for alpha",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
      expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
    },
  );

  it("missing global catalog entry never selects another pending chat or sends its input", async () => {
    const saved = savedDestination(sideChatId);
    const collection = saved.children.cakeChatCollectionStore;
    if (!collection || Array.isArray(collection)) throw new Error("Expected collection");
    collection.children.pendingSessions = node({
      conversationIds: [sideChatId],
      pendingSessionIds: [sideChatId],
    });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
    using fixture = renderAppShellNavigation(
      { sessionChats: { prompt } },
      { snapshot: saved, cakeChatCatalogLoaded: false },
    );
    await act(async () => {
      applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
      await fixture.root.cakeChatCollectionStore.initialize();
    });
    expect(globalComposer()).toHaveProperty("value", "");
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(CAKE_CHAT_SESSION_ID);
    expect(prompt).not.toHaveBeenCalled();
    expect(
      toSnapshot(fixture.root.cakeChatCollectionStore.pendingSessions).state.pendingSessionIds,
    ).toContain(sideChatId);
  });

  it("startup normalization preserves all non-navigation conversation data without mutating saved input", () => {
    const saved = savedDestination(sideChatId);
    const before = structuredClone(saved);
    const result = startupSnapshot(saved);
    expect(result.children.sessionRegistry).toEqual(saved.children.sessionRegistry);
    expect(result.children.sessionLayoutStore).toEqual(saved.children.sessionLayoutStore);
    const collection = result.children.cakeChatCollectionStore;
    const original = saved.children.cakeChatCollectionStore;
    if (!collection || Array.isArray(collection) || !original || Array.isArray(original))
      throw new Error("Expected collection");
    expect(collection.children.registry).toEqual(original.children.registry);
    expect(startupSnapshot(result)).toEqual(result);
    expect(saved).toEqual(before);
  });
});
