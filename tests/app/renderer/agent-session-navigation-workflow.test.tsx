/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import {
  Markdown,
  MarkdownLinkProvider,
} from "../../../src/renderer/components/ai-elements/markdown";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageReference } from "../../../src/contracts/conversations/message-reference";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { WindowStatePersistence } from "../../../src/renderer/persistence/WindowStatePersistence";
import { searchSettings } from "../../../src/renderer/lib/settings-search";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { applyAutomationCatalogUpdate } from "../../../src/renderer/reducers/AutomationReducer";
import { automationSession, automationSummary } from "./fixtures/automation-fixtures";

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

const expectChat = async (name: string) =>
  expect(await screen.findByPlaceholderText(`Ask Cake to work in ${name}…`)).toBeDefined();
const openSettings = async (fixture: ReturnType<typeof renderAppShellNavigation>) => {
  const settingsButton = screen.queryAllByRole("button", { name: "Settings" })[0];
  if (settingsButton) await fixture.user.click(settingsButton);
  await fixture.user.click(await screen.findByRole("button", { name: /^Agent\b/ }));
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
  it("returns home after a worker/tool visit without replacing Project Chat's draft or reading state", async () => {
    using fixture = renderAppShellNavigation();
    const projectChatId = `project-chat:${"a".repeat(64)}`;
    act(() =>
      applySnapshot(fixture.models.cakeChatCatalog, {
        loaded: true,
        sessions: [
          ...(toSnapshot(fixture.models.cakeChatCatalog).sessions ?? []),
          {
            sessionId: projectChatId,
            projectPath: "/alpha",
            title: "Alpha chat",
            createdAt: new Date(0).toISOString(),
            modifiedAt: new Date(0).toISOString(),
            messageCount: 0,
            resolved: false,
            unread: false,
          },
        ],
      }),
    );
    await fixture.publishCakeChatProjection(projectChatId);
    await act(async () => {
      await fixture.root.navigationStore.openProjectChat("/alpha");
    });
    const home = fixture.root.cakeChatCollectionStore.registry.find(projectChatId)!;
    const chat = home.conversationSessionStore.chatStore;
    act(() => {
      home.conversationSessionStore.composerStore.draftStore.setText("retained Project Chat draft");
      chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
      home.showPresentation("browser");
    });
    await act(async () => {
      await fixture.root.navigationStore.openSession("alpha");
    });
    await fixture.user.click(
      within(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).getByRole(
        "button",
        { name: "alpha" },
      ),
    );
    await waitFor(() =>
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(projectChatId),
    );
    expect(home.presentationMode).toBe("normal");
    expect(home.conversationSessionStore.chatStore).toBe(chat);
    expect(home.conversationSessionStore.composerStore.draftStore.text).toBe(
      "retained Project Chat draft",
    );
    expect(chat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
    await act(async () => {
      await fixture.root.navigationStore.openSession("alpha");
    });
    await act(async () => {
      expect(
        await fixture.root.applicationControlStore.invoke({ name: "app.home", arguments: {} }),
      ).toMatchObject({ ok: true, opened: true });
    });
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(projectChatId);
  });

  it("opens a real global Automation Session without Project lookup and still honors navigation permission", async () => {
    const lookup = vi.fn<Client["projectSessions"]["lookup"]>();
    using fixture = renderAppShellNavigation({ projectSessions: { lookup } });
    const session = automationSession({ unread: false });
    act(() =>
      applyAutomationCatalogUpdate(fixture.models.automations, {
        _tag: "Snapshot",
        snapshot: {
          revision: 1,
          automations: [
            automationSummary({ activity: { runningSessions: 1, queuedOccurrences: 0 } }),
          ],
          unresolvedSessions: [session],
        },
      }),
    );
    const invoke = () =>
      fixture.root.applicationControlStore.invoke(
        { name: "sessions.open", arguments: { sessionId: session.identity.sessionId } },
        { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
      );
    await act(async () => {
      expect(await invoke()).toEqual({
        ok: true,
        command: "sessions.open",
        opened: { sessionId: session.identity.sessionId },
      });
    });
    expect(await screen.findByRole("combobox", { name: "Message automation run" })).toBeTruthy();
    expect(lookup).not.toHaveBeenCalled();
    await fixture.user.click(await openSettings(fixture));
    await act(async () => {
      expect(await invoke()).toMatchObject({
        ok: false,
        error: expect.stringContaining("disabled"),
      });
    });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("opens the target in the invoking window, not a background caller's window", async () => {
    const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
      async () => undefined,
    );
    using otherWindow = createRendererStoreFixture();
    using fixture = renderAppShellNavigation({ projectSessions: { respondControl } });
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("alpha");
    });
    await expectChat("alpha");
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("gamma");
    });
    await expectChat("gamma");
    await requestOpen(fixture, { sessionId: "beta" });
    await expectChat("beta");
    expect(fixture.root.sessionLayoutStore.focusedSessionId).toBe("beta");
    expect(otherWindow.root.appShellStore.selection).toEqual({
      kind: "cake-chat",
      sessionId: CAKE_CHAT_SESSION_ID,
    });
    expect(respondControl).toHaveBeenCalledWith(
      "alpha",
      expect.any(String),
      { ok: true, command: "sessions.open", opened: { workspacePath: "/beta", sessionId: "beta" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([CAKE_CHAT_SESSION_ID, `project-chat:${"a".repeat(64)}`])(
    "opens and re-focuses permanent chat %s without Project Session lookup, honoring permission",
    async (sessionId) => {
      const lookup = vi.fn<Client["projectSessions"]["lookup"]>();
      const open = vi.fn<Client["cakeChats"]["open"]>(async () => undefined);
      using fixture = renderAppShellNavigation({
        projectSessions: { lookup },
        cakeChats: { open },
      });
      if (sessionId !== CAKE_CHAT_SESSION_ID)
        act(() =>
          applySnapshot(fixture.models.cakeChatCatalog, {
            loaded: true,
            sessions: [
              ...(toSnapshot(fixture.models.cakeChatCatalog).sessions ?? []),
              {
                sessionId,
                projectPath: "/alpha",
                title: "Alpha chat",
                createdAt: new Date(0).toISOString(),
                modifiedAt: new Date(0).toISOString(),
                messageCount: 0,
                resolved: false,
                unread: false,
              },
            ],
          }),
        );
      if (sessionId !== CAKE_CHAT_SESSION_ID) await fixture.publishCakeChatProjection(sessionId);
      const invoke = () =>
        fixture.root.applicationControlStore.invoke(
          { name: "sessions.open", arguments: { sessionId } },
          { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
        );
      await act(async () => {
        expect(await invoke()).toMatchObject({ ok: true, opened: { sessionId } });
      });
      expect(fixture.root.cakeChatCollectionStore.sessionId).toBe(sessionId);
      await act(async () => {
        expect(await invoke()).toMatchObject({ ok: true });
      });
      expect(lookup).not.toHaveBeenCalled();
      await fixture.user.click(await openSettings(fixture));
      await act(async () => {
        expect(await invoke()).toMatchObject({
          ok: false,
          error: expect.stringContaining("disabled"),
        });
      });
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("opens a registered Project Chat before its passive catalog projection arrives", async () => {
    const sessionId = `project-chat:${"c".repeat(64)}`;
    const summary = {
      sessionId,
      projectPath: "/alpha",
      title: "New registered chat",
      createdAt: new Date(0).toISOString(),
      modifiedAt: new Date(0).toISOString(),
      messageCount: 0,
      resolved: false,
      unread: false,
    };
    const lookup = vi.fn(async () => summary);
    const open = vi.fn<Client["cakeChats"]["open"]>(async () => undefined);
    const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
      async () => undefined,
    );
    using fixture = renderAppShellNavigation({
      cakeChats: { lookup, open },
      projectSessions: { respondControl },
    });
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("alpha");
    });
    await expectChat("alpha");
    await fixture.publishCakeChatProjection(sessionId);
    expect(fixture.models.cakeChatCatalog.find(sessionId)).toBeUndefined();
    open.mockClear();
    await requestOpen(fixture, { sessionId });
    expect(respondControl).toHaveBeenLastCalledWith(
      "alpha",
      expect.any(String),
      { ok: true, command: "sessions.open", opened: { sessionId, workspacePath: "/alpha" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
    ).toBe(sessionId);
    expect(screen.getByRole("combobox", { name: "Message Project Chat" })).toBeDefined();
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      { sessionId },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fixture.models.cakeChatConversation(sessionId).historyOnly).toBe(true);
    expect(fixture.root.cakeChatCollectionStore.registry.observationTargets).toContainEqual(
      expect.objectContaining({ sessionId }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(fixture.models.cakeChatCatalog.find(sessionId)?.projectPath).toBe("/alpha");
  });

  it("does not navigate to an unregistered canonical Project Chat missing from the projection", async () => {
    const sessionId = `project-chat:${"d".repeat(64)}`;
    const lookup = vi.fn(async () => {
      throw new Error("Project Chat belongs to no registered project");
    });
    const open = vi.fn<Client["cakeChats"]["open"]>(async () => undefined);
    const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
      async () => undefined,
    );
    using fixture = renderAppShellNavigation({
      cakeChats: { lookup, open },
      projectSessions: { respondControl },
    });
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("alpha");
    });
    await expectChat("alpha");
    open.mockClear();
    await requestOpen(fixture, { sessionId });
    expect(respondControl).toHaveBeenLastCalledWith(
      "alpha",
      expect.any(String),
      {
        ok: false,
        command: "sessions.open",
        error: "Project Chat belongs to no registered project",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expectChat("alpha");
    expect(open).not.toHaveBeenCalled();
    expect(fixture.models.cakeChatCatalog.find(sessionId)).toBeUndefined();
  });

  it("requests Project Chat focus after first history, not on a later live snapshot", async () => {
    const sessionId = `project-chat:${"a".repeat(64)}`;
    using fixture = renderAppShellNavigation();
    const history: UiPart = {
      id: "retained-answer",
      kind: "text",
      role: "assistant",
      text: "Retained Project Chat history",
      status: "complete",
    };
    await fixture.publishCakeChatProjection(sessionId, [history]);
    act(() => {
      applySnapshot(fixture.models.cakeChatCatalog, {
        loaded: true,
        sessions: [
          {
            sessionId,
            projectPath: "/alpha",
            title: "Alpha chat",
            createdAt: new Date(0).toISOString(),
            modifiedAt: new Date(0).toISOString(),
            messageCount: 0,
            resolved: false,
            unread: false,
          },
        ],
      });
      fixture.root.cakeChatCollectionStore.registry.load(sessionId);
      fixture.root.navigationStore.selectCakeChat(sessionId);
      fixture.root.sessionLayoutStore.showSession("alpha");
      fixture.root.navigationStore.selectProjectSession("alpha");
    });
    const draft =
      fixture.root.cakeChatCollectionStore.registry.find(sessionId)!.conversationSessionStore
        .composerStore.draftStore;
    const before = draft.focusRequestRevision;
    await fixture.user.click(screen.getByRole("button", { name: "Open Project Chat for alpha" }));
    expect(fixture.models.cakeChatConversation(sessionId).historyOnly).toBe(true);
    expect(fixture.models.cakeChatConversation(sessionId).uiParts).toContainEqual(history);
    expect(fixture.root.cakeChatCollectionStore.registry.observationTargets).toContainEqual(
      expect.objectContaining({ sessionId }),
    );
    // Electron covers actual input focus; this regression owns the async request timing.
    await waitFor(() => expect(draft.focusRequestRevision).toBe(before + 1));
    await act(async () => {
      await fixture.root.navigationStore.openSession("alpha");
    });
    const otherInput = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.click(otherInput);
    await fixture.user.type(otherInput, "Keep typing here");
    const live: UiPart = { ...history, id: "live-answer", text: "Later live snapshot" };
    await fixture.publishCakeChatProjection(sessionId, [history, live], "Snapshot");
    expect(fixture.models.cakeChatConversation(sessionId).historyOnly).toBe(false);
    expect(fixture.models.cakeChatConversation(sessionId).uiParts).toContainEqual(live);
    expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("alpha");
    expect(document.activeElement).toBe(otherInput);
    expect(otherInput).toHaveProperty("value", "Keep typing here");
    expect(draft.focusRequestRevision).toBe(before + 1);
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
        text: "## Original evidence\n\n**Exact original evidence**",
        totalChars: 48,
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
      expect(screen.getByRole("heading", { name: "Original evidence" })).toBeDefined();
      expect(screen.getByText("Exact original evidence").getAttribute("data-streamdown")).toBe(
        "strong",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Copy message" }));
      expect(await screen.findByRole("button", { name: "Copied message" })).toBeDefined();
      expect(await navigator.clipboard.readText()).toBe(
        "## Original evidence\n\n**Exact original evidence**",
      );
      expect(inspect).toHaveBeenCalledTimes(1);
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

  it.each(["beta", CAKE_CHAT_SESSION_ID])(
    "resolves linked entry text before activity and continues keyboard navigation in %s",
    async (sessionId) => {
      using fixture = renderAppShellNavigation();
      const session =
        sessionId === CAKE_CHAT_SESSION_ID
          ? fixture.root.cakeChatCollectionStore.registry.find(sessionId)!
          : fixture.root.sessionRegistry.findSession(sessionId)!;
      const parts: UiPart[] = [
        { id: "before", kind: "text", role: "assistant", text: "Before", status: "complete" },
        { id: "entry-linked-reasoning-0", kind: "reasoning", text: "Thinking", status: "complete" },
        {
          id: "entry-linked-text-1",
          entryId: "linked",
          kind: "text",
          role: "assistant",
          text: "Linked answer",
          status: "complete",
        },
        { id: "after", kind: "text", role: "assistant", text: "After", status: "complete" },
      ];
      act(() => {
        for (const part of parts)
          applyConversationUpdate(session.model, {
            _tag: "Event",
            revision: 2,
            event: { _tag: "PartUpdated", sessionId, part },
          });
      });
      await act(async () => fixture.root.navigationStore.openSessionLink(sessionId, "linked"));
      const interaction = session.conversationSessionStore.chatStore.transcriptInteraction;
      expect(interaction.selectedMessageId).toBe("entry-linked-text-1");
      act(() => interaction.selectPreviousMessage());
      expect(interaction.selectedMessageId).toBe("before");
      await act(async () => fixture.root.navigationStore.openSessionLink(sessionId, "linked"));
      act(() => interaction.selectNextMessage());
      expect(interaction.selectedMessageId).toBe("after");
      // An exact activity part link remains exact rather than jumping to text.
      await act(async () =>
        fixture.root.navigationStore.openSessionLink(sessionId, "entry-linked-reasoning-0"),
      );
      expect(interaction.selectedMessageId).toBe("entry-linked-reasoning-0");
    },
  );

  it.each(["beta", CAKE_CHAT_SESSION_ID])(
    "Cake links reveal the exact message in normal chat and session-only links return to %s",
    async (sessionId) => {
      const inspect = vi.fn<Client["sessionChats"]["inspect"]>();
      using fixture = renderAppShellNavigation(
        { sessionChats: { inspect } },
        { transcriptViewport: true },
      );
      // Start in a different conversation so both link targets exercise navigation,
      // independent of the unconditional global startup destination.
      await fixture.selectSession("alpha");
      const session =
        sessionId === CAKE_CHAT_SESSION_ID
          ? fixture.root.cakeChatCollectionStore.registry.find(sessionId)!
          : fixture.root.sessionRegistry.findSession(sessionId)!;
      const entryId = "exact:entry/1";
      act(() => {
        for (const [id, text] of [
          ["older", "Exact linked answer"],
          ["newer", "Newer answer"],
        ] as const)
          applyConversationUpdate(session.model, {
            _tag: "Event",
            revision: 2,
            event: {
              _tag: "PartUpdated",
              sessionId,
              part: {
                id,
                entryId: id === "older" ? entryId : id,
                kind: "text",
                role: "assistant",
                text,
                status: "complete",
              },
            },
          });
        session.showPresentation("browser");
        // jsdom cannot settle Virtuoso's native bottom alignment; Electron owns pixel scrolling.
        session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition(
          { kind: "top" },
        );
      });
      render(
        <MarkdownLinkProvider
          actions={{
            openExternalUrl: vi.fn(),
            openSession: (id, messageId) => {
              void fixture.root.navigationStore.openSessionLink(id, messageId);
            },
          }}
        >
          <Markdown>{`[Exact answer](${messageReference(sessionId, entryId)}) · [Dedicated fix](cake://session/${sessionId})`}</Markdown>
        </MarkdownLinkProvider>,
      );
      await fixture.user.click(screen.getByRole("link", { name: "Exact answer" }));
      await screen.findByText("Exact linked answer");
      expect(session.presentationMode).toBe("normal");
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(sessionId);
      const interaction = session.conversationSessionStore.chatStore.transcriptInteraction;
      await waitFor(() => expect(interaction.selectedMessageId).toBe("older"));
      expect(interaction.messageSelection?.origin).toBe("navigation");
      expect(
        document
          .querySelector('[data-slot="transcript-item"][aria-current="true"] [data-part-id]')
          ?.getAttribute("data-part-id"),
      ).toBe("older");
      expect(inspect).not.toHaveBeenCalled();

      act(() => session.showPresentation("browser"));
      await fixture.user.click(screen.getByRole("link", { name: "Dedicated fix" }));
      await waitFor(() => expect(session.presentationMode).toBe("normal"));
      await screen.findByText("Exact linked answer");
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe(sessionId);
    },
  );

  it("keeps a missing message link in normal chat and reports unavailability instead of inspecting an original", async () => {
    const inspect = vi.fn<Client["sessionChats"]["inspect"]>();
    using fixture = renderAppShellNavigation({ sessionChats: { inspect } });
    await act(async () => {
      await expect(
        fixture.root.navigationStore.openSessionLink("beta", "outside-branch"),
      ).rejects.toThrow("The linked message is unavailable in the current conversation");
    });
    await expectChat("beta");
    expect(inspect).not.toHaveBeenCalled();
  });

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

  it.each(["missing", `project-chat:${"f".repeat(64)}`, "", 42])(
    "rejects invalid Project Session target %s without navigating",
    async (sessionId) => {
      const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
      const respondControl = vi.fn<Client["projectSessions"]["respondControl"]>(
        async () => undefined,
      );
      using fixture = renderAppShellNavigation({ projectSessions: { open, respondControl } });
      await act(async () => {
        await fixture.root.navigationStore.openSessionLink("alpha");
      });
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
    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("alpha");
    });
    // This permission scenario starts from a landed conversation. Pending
    // selection versus a newer Settings intent is covered independently.
    await expectChat("alpha");
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

    await act(async () => {
      await fixture.root.navigationStore.openSessionLink("beta");
    });
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
    using restored = renderAppShellNavigation(
      { projectSessions: { respondControl } },
      { snapshot: saved },
    );
    expect((await openSettings(restored)).getAttribute("aria-checked")).toBe("false");
    await requestOpen(restored, { sessionId: "beta" });
    expect(respondControl.mock.calls.at(-1)?.[2]).toMatchObject({
      ok: false,
      error: expect.stringContaining("disabled"),
    });
    // No permission field is accepted by an agent-writable Settings section.
    await expect(
      restored.root.applicationControlStore.invoke({
        name: "settings.window.update",
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
