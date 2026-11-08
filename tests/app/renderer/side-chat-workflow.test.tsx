/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { StoreProvider } from "r-state-tree/react";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import {
  DiscussionSessionStartInput,
  type DiscussionThread,
} from "../../../src/contracts/discussion-sessions/discussion-session-data";
import { builtinSlashCommands } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { ConversationFocusContext } from "../../../src/renderer/lib/conversation-focus-context";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import type { MessageSelectionAnchor } from "../../../src/renderer/stores/MessageCommentsStore";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function conversation(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
    thinkingLevel: "high",
    availableThinkingLevels: ["off", "high"],
    streaming: false,
    diagnostics: [],
    commands: builtinSlashCommands,
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

function thread(id: string, title: string): DiscussionThread {
  return {
    id,
    sidecarSessionId: `sidecar-${id}`,
    parentSessionId: "parent-1",
    workingDirectory: "/project",
    anchor: {
      path: "session:parent-1",
      view: "session",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: "",
      contextBefore: "",
      contextAfter: "",
      diff: "",
    },
    parts: [{ id: `${id}-prompt`, kind: "text", role: "user", text: title, status: "complete" }],
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderSideChats(
  start: Client["discussionSessions"]["start"],
  options: {
    threads?: DiscussionThread[];
    selection?: MessageSelectionAnchor;
    withoutModel?: boolean;
    streaming?: boolean;
    streamingThreads?: readonly string[];
    commands?: ConversationSnapshot["commands"];
    setResolved?: Client["discussionSessions"]["setResolved"];
  } = {},
) {
  const fixture = createRendererStoreFixture({
    client: { discussionSessions: { start, setResolved } },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({
        sessionId: "parent-1",
        projectPath: "/project",
        workingDirectory: "/project",
      }),
    ],
  });
  const session = fixture.root.sessionRegistry.load("parent-1", "/project");
  fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/project";
  fixture.root.navigationStore.selectProjectSession("parent-1");
  const snapshot = {
    ...conversation("parent-1"),
    streaming: options.streaming ?? false,
    commands: options.commands ?? builtinSlashCommands,
  };
  if (options.withoutModel) Object.assign(snapshot, { model: undefined });
  applyConversationSnapshot(session.model, snapshot);
  let revision = 0;
  let currentThreads = options.threads ?? [];
  const resolutions = vi.fn<Client["discussionSessions"]["setResolved"]>(async (input, request) => {
    if (options.setResolved) return options.setResolved(input, request);
    const updated = currentThreads.map((item) =>
      item.id === input.threadId
        ? { ...item, status: input.resolved ? ("resolved" as const) : ("open" as const) }
        : item,
    );
    act(() => publish(updated));
    const resolvedThread = updated.find((item) => item.id === input.threadId);
    if (!resolvedThread) throw new Error("Missing side chat");
    return resolvedThread;
  });
  function setResolved(...args: Parameters<Client["discussionSessions"]["setResolved"]>) {
    return resolutions(...args);
  }
  function publish(threads: DiscussionThread[]) {
    currentThreads = threads;
    for (const item of threads) {
      if (!item.sidecarSessionId) continue;
      const model = fixture.models.discussionConversation(item.sidecarSessionId, "/project");
      applyDiscussionSessionUpdate(model, item.sidecarSessionId, {
        _tag: "Snapshot",
        revision: revision + 1,
        snapshot: {
          identity: {
            _tag: "DiscussionSession",
            sessionId: item.sidecarSessionId,
            parentSessionId: "parent-1",
          },
          conversation: {
            ...conversation(item.sidecarSessionId),
            parts: item.parts,
            streaming: options.streamingThreads?.includes(item.id) ?? false,
          },
        },
      });
    }
    applyDiscussionCatalogUpdate(fixture.models.discussionCatalog("parent-1"), "parent-1", {
      _tag: "Snapshot",
      revision: ++revision,
      parentSessionId: "parent-1",
      threads,
    });
  }
  publish(options.threads ?? []);
  if (options.selection) {
    // Establish an already-open selection draft; native text-selection initiation is not covered here.
    session.messageCommentsStore.prepareDraft(options.selection);
    session.conversationSessionStore.sideChatStore.open({
      key: "selection-draft",
      title: "Side chat",
      eyebrow: () => "Selection",
      chatStore: session.messageCommentsStore.draftChatStore,
    });
  }
  const view = render(
    <StoreProvider store={fixture.root}>
      <ConversationFocusContext.Provider value>
        <SideChatLayout
          store={session.conversationSessionStore.sideChatStore}
          renderChat={(chat, composerHeader) => (
            <Chat
              store={chat}
              composerHeader={composerHeader}
              embedded
              composerFocusEnabled={false}
            />
          )}
        >
          <SideChatsMenu store={session} />
          <Chat
            store={session.conversationSessionStore.chatStore}
            embedded
            composerFocusEnabled={false}
          />
        </SideChatLayout>
      </ConversationFocusContext.Provider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    session,
    resolutions,
    publish(threads: DiscussionThread[]) {
      act(() => publish(threads));
    },
    publishCommands(commands: ConversationSnapshot["commands"]) {
      act(() => applyConversationSnapshot(session.model, { ...snapshot, commands }));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

let availableWidth = 1200;
let resizeLayout: () => void;
beforeEach(() => {
  availableWidth = 1200;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const rect = measure.call(this);
      return this.getAttribute("data-slot") === "side-chat-layout"
        ? { ...rect, width: availableWidth }
        : rect;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(element: HTMLElement) {
        if (element.getAttribute("data-slot") === "side-chat-layout") resizeLayout = this.callback;
      }
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Secondary conversation workflows", () => {
  it.each([416, 700, 1200])(
    "dismisses without resolving and preserves drafts across resize (initial area: %ipx)",
    async (width) => {
      availableWidth = width;
      const start = vi.fn<Client["discussionSessions"]["start"]>();
      using fixture = renderSideChats(start, { threads: [thread("first", "First discussion")] });
      const mainChat = fixture.session.conversationSessionStore.chatStore;
      const mainInput = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
      await fixture.user.type(mainInput, "Main draft");
      act(() => mainChat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" }));
      const openSideChat = async () => {
        await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
        await fixture.user.click(screen.getByRole("button", { name: "First discussion" }));
        return screen.getByRole("complementary", { name: "Side chat" });
      };
      let panel = await openSideChat();
      const layout = panel.closest('[data-slot="side-chat-layout"]')!;
      const origin = layout.firstElementChild!;
      const sideInput = within(panel).getByRole<HTMLTextAreaElement>("combobox");
      const sideChatStore = fixture.session.conversationSessionStore.sideChatStore;
      const sideChat = sideChatStore.target!.chatStore!;
      act(() => sideChatStore.setWidth(600));
      await fixture.user.type(sideInput, "Side draft");
      act(() => sideChat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" }));
      expect(layout.getAttribute("data-presentation")).toBe(
        width >= 860 ? "side-by-side" : "replacement",
      );
      // The local chat area, not the outer editor/browser/window width, owns this breakpoint.
      for (const nextWidth of [860, 859, 320, 1200, 416]) {
        act(() => {
          availableWidth = nextWidth;
          resizeLayout();
        });
        const split = nextWidth >= 860;
        expect(layout.getAttribute("data-presentation")).toBe(
          split ? "side-by-side" : "replacement",
        );
        expect(origin.hasAttribute("inert")).toBe(!split);
        expect((layout as HTMLElement).style.getPropertyValue("--accessory-panel-width")).toBe(
          split ? `${Math.min(600, nextWidth * 0.6)}px` : "0px",
        );
        expect(sideChatStore.width).toBe(600);
        expect(screen.queryByRole("separator", { name: "Resize side chat" }) !== null).toBe(split);
        expect(within(panel).getByRole("combobox")).toBe(sideInput);
        expect(sideInput.value).toBe("Side draft");
        expect(mainInput.isConnected).toBe(true);
        expect(mainInput.value).toBe("Main draft");
        expect(mainChat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
        expect(sideChat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
      }
      const close = within(panel).getByRole("button", { name: "Close side chat" });
      act(() => close.focus());
      await fixture.user.keyboard("{Enter}");
      expect(layout.getAttribute("data-presentation")).toBe("closed");
      expect(origin.hasAttribute("inert")).toBe(false);
      expect(screen.getByRole("combobox", { name: "Message" })).toBe(mainInput);
      expect(mainInput.value).toBe("Main draft");
      expect(fixture.resolutions).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      panel = await openSideChat();
      expect(within(panel).getByRole("combobox")).toHaveProperty("value", "Side draft");
      expect(sideChat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
      // Resolution remains a separate, explicit lifecycle action.
      await fixture.user.click(within(panel).getByRole("button", { name: "Close and resolve" }));
      expect(fixture.resolutions).toHaveBeenCalledTimes(1);
    },
  );
  it.each([false, true])(
    "creates a session-wide side chat (without model: %s) and opens it when the catalog arrives",
    async (withoutModel) => {
      const created = thread("new-thread", "Compare approaches");
      const start = vi.fn<Client["discussionSessions"]["start"]>(async (input) => {
        // Exercise the same encoder as RPC; a typed fake alone accepts explicit undefined keys.
        Schema.encodeSync(DiscussionSessionStartInput)(input);
        return {
          turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
          thread: created,
        };
      });
      using fixture = renderSideChats(start, { withoutModel });
      const input = screen.getByRole<HTMLTextAreaElement>("combobox");
      expect(screen.queryByRole("button", { name: /^Side chats,/ })).toBeNull();
      await fixture.user.type(input, "/sidechat Compare approaches");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      const expectedInput: DiscussionSessionStartInput = {
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        text: "Compare approaches",
        anchor: created.anchor,
        annotations: [],
      };
      if (!withoutModel)
        Object.assign(expectedInput, {
          model: { provider: "openai-codex", id: "gpt-5.6-sol" },
          thinkingLevel: "high",
        });
      await waitFor(() =>
        expect(start).toHaveBeenCalledExactlyOnceWith(
          expectedInput,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(input.value).toBe("");
      expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
      fixture.publish([created]);
      const panel = await screen.findByRole("complementary", { name: "Side chat" });
      expect(screen.getByRole("combobox", { name: "Message" })).toBe(input);
      expect(screen.getByRole("separator", { name: "Resize side chat" })).toBeDefined();
      expect(within(panel).getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
      await fixture.user.click(within(panel).getByRole("button", { name: "Close and resolve" }));
      expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
      expect(screen.getByRole("combobox")).toBeDefined();
    },
  );

  it("updates an unchanged slash query when authoritative commands arrive and are removed", async () => {
    const start = vi.fn<Client["discussionSessions"]["start"]>();
    using fixture = renderSideChats(start, { commands: [] });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    await fixture.user.type(input, "/side");
    expect(screen.queryByRole("option")).toBeNull();

    fixture.publishCommands(builtinSlashCommands);
    expect(
      await screen.findByRole("option", { name: /sidechat \[prompt\] Start a side chat/ }),
    ).toBeDefined();
    expect(input.value).toBe("/side");

    fixture.publishCommands([]);
    expect(screen.queryByRole("option")).toBeNull();
    expect(input.value).toBe("/side");
    fixture.publishCommands(builtinSlashCommands);
    await screen.findByRole("option", { name: /sidechat \[prompt\] Start a side chat/ });
    await fixture.user.keyboard("{Enter}");
    expect(await screen.findByRole("complementary", { name: "Side chat" })).toBeDefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("discovers bare /sidechat and opens a session-wide draft while the parent streams", async () => {
    const created = thread("bare-thread", "Compare approaches");
    const start = vi.fn<Client["discussionSessions"]["start"]>(async () => ({
      turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
      thread: created,
    }));
    using fixture = renderSideChats(start, { streaming: true });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    await fixture.user.type(input, "/side");
    expect(
      await screen.findByRole("option", {
        name: /sidechat \[prompt\] Start a side chat/,
      }),
    ).toBeDefined();
    await fixture.user.keyboard("{Enter}");
    const panel = await screen.findByRole("complementary", { name: "Side chat" });
    expect(start).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    await fixture.user.type(
      within(panel).getByRole("combobox", { name: "Message side chat" }),
      "Compare approaches",
    );
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0]).toMatchObject({
      parentSessionId: "parent-1",
      text: "Compare approaches",
      anchor: created.anchor,
    });
    fixture.publish([created]);
    expect(
      await within(panel).findByRole("combobox", { name: "Reply to side chat" }),
    ).toBeDefined();
    await fixture.user.type(within(panel).getByRole("combobox"), "/sidechat");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    expect(
      await within(panel).findByText("Side chats are unavailable in this conversation"),
    ).toBeDefined();
    expect(within(panel).getByRole<HTMLTextAreaElement>("combobox").value).toBe("/sidechat");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("replaces the open side chat and closes/resolves only the selected thread", async () => {
    const start = vi.fn<Client["discussionSessions"]["start"]>();
    const first = thread("first", "First discussion");
    const second = {
      ...thread("second", "Second discussion"),
      anchor: {
        ...thread("second", "").anchor,
        view: "message" as const,
        path: "session:parent-1/message/answer",
        messageId: "answer",
        selectedText: "Selected passage",
      },
    };
    using fixture = renderSideChats(start, { threads: [first, second] });
    const trigger = screen.getByRole("button", { name: "Side chats, 2 open" });
    expect(within(trigger).getByText("2").classList.contains("bg-card")).toBe(true);
    await fixture.user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await fixture.user.click(screen.getByRole("button", { name: /First discussion/ }));
    expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
    await fixture.user.click(screen.getByRole("button", { name: /Selected passage/ }));
    expect(screen.getAllByRole("complementary", { name: "Side chat" })).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Reply to side chat" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Close and resolve" }));
    expect(fixture.resolutions).toHaveBeenCalledWith(
      {
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        threadId: "second",
        resolved: true,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: /First discussion/ }));
    expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps a side chat open on resolution failure and permits retry", async () => {
    const setResolved = vi
      .fn<Client["discussionSessions"]["setResolved"]>()
      .mockRejectedValueOnce(new Error("Resolution failed"))
      .mockResolvedValueOnce({ ...thread("first", "First discussion"), status: "resolved" });
    using fixture = renderSideChats(vi.fn<Client["discussionSessions"]["start"]>(), {
      threads: [thread("first", "First discussion")],
      setResolved,
    });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "First discussion" }));
    await fixture.user.click(screen.getByRole("button", { name: "Close and resolve" }));
    expect(screen.getByRole("complementary", { name: "Side chat" })).toBeDefined();
    expect(screen.getByText("Could not resolve side chat. Try again.")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Close and resolve" }));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    expect(setResolved).toHaveBeenCalledTimes(2);
  });

  it("lists only open user side chats, projects live activity, and follows catalog removal", async () => {
    const start = vi.fn<Client["discussionSessions"]["start"]>();
    const selection = {
      ...thread("selection", "Explain this"),
      anchor: {
        ...thread("selection", "").anchor,
        view: "message" as const,
        path: "session:parent-1/message/answer",
        messageId: "answer",
        selectedText: "The important selection",
      },
    };
    const resolved = { ...thread("resolved", "Resolved discussion"), status: "resolved" as const };
    const code = {
      ...thread("code", "Code discussion"),
      anchor: { ...thread("code", "").anchor, view: "file" as const, path: "src/app.ts" },
    };
    using fixture = renderSideChats(start, {
      threads: [resolved, code, selection],
      streamingThreads: [selection.id],
    });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    const menu = within(screen.getByLabelText("Open side chats"));
    expect(menu.getByText("Working…")).toBeDefined();
    expect(menu.getByRole("heading", { name: "Side chats" })).toBeDefined();
    expect(menu.queryByText(/subagents|resolved|history/i)).toBeNull();
    expect(menu.queryByText(/Resolved discussion|Code discussion/)).toBeNull();
    await fixture.user.click(menu.getByRole("button", { name: /The important selection/ }));
    expect(screen.queryByLabelText("Open side chats")).toBeNull();
    const panel = within(screen.getByRole("complementary", { name: "Side chat" }));
    expect(panel.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();
    expect(panel.getByRole("button", { name: "Stop" })).toBeDefined();
    await fixture.user.click(panel.getByRole("button", { name: "Close and resolve" }));
    fixture.publish([resolved, code, { ...selection, status: "resolved" }]);
    expect(screen.queryByRole("button", { name: /^Side chats,/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    { artifactId: undefined, entryId: "entry-1" },
    { artifactId: undefined, entryId: undefined },
    { artifactId: "cake-s4-table", entryId: "entry-1" },
    { artifactId: "cake-s4-table", entryId: undefined },
  ])(
    "submits a selection draft ($artifactId, $entryId) and hands off to the live thread",
    async ({ artifactId, entryId }) => {
      const selection: MessageSelectionAnchor = {
        messageId: "assistant-1",
        entryId,
        selectedText: "Original selection",
        startOffset: 4,
        endOffset: 22,
        contextBefore: "The ",
        contextAfter: " matters.",
        artifactId,
      };
      const created: DiscussionThread = {
        ...thread("selection-thread", "Explain the selection"),
        anchor: {
          path: artifactId
            ? `session:parent-1/artifact/${artifactId}`
            : "session:parent-1/message/assistant-1",
          view: artifactId ? "artifact" : "message",
          start: { diffLine: 0 },
          end: { diffLine: 0 },
          selectedText: selection.selectedText,
          contextBefore: selection.contextBefore,
          contextAfter: selection.contextAfter,
          diff: "",
          startOffset: selection.startOffset,
          endOffset: selection.endOffset,
        },
      };
      if (!artifactId) Object.assign(created.anchor, { messageId: selection.messageId });
      if (entryId !== undefined) Object.assign(created.anchor, { entryId });
      const start = vi.fn<Client["discussionSessions"]["start"]>(async (input) => {
        Schema.encodeSync(DiscussionSessionStartInput)(input);
        return {
          turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
          thread: created,
        };
      });
      using fixture = renderSideChats(start, { selection });
      const input = screen.getByRole<HTMLTextAreaElement>("combobox", {
        name: "Message about selected text",
      });
      await fixture.user.type(input, "Explain the selection");
      const panel = screen.getByRole("complementary", { name: "Side chat" });
      await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(start).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            text: "Explain the selection",
            anchor: created.anchor,
            annotations: [],
          }),
          expect.any(Object),
        ),
      );
      fixture.publish([created]);
      await waitFor(() =>
        expect(screen.queryByRole("combobox", { name: "Message about selected text" })).toBeNull(),
      );
      expect(
        within(panel).getByRole("combobox", { name: "Reply to selection side chat" }),
      ).toBeDefined();
    },
  );
});
