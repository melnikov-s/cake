/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
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
    metadata?: DiscussionThread[];
    delaySidecars?: boolean;
    list?: Client["discussionSessions"]["list"];
    prompt?: Client["sessionChats"]["prompt"];
    selection?: MessageSelectionAnchor;
    withoutModel?: boolean;
    streaming?: boolean;
    streamingThreads?: readonly string[];
    commands?: ConversationSnapshot["commands"];
    setResolved?: Client["discussionSessions"]["setResolved"];
    transcriptViewport?: boolean;
  } = {},
) {
  const fixture = createRendererStoreFixture({
    client: {
      discussionSessions: { start, setResolved, list: options.list },
      sessionChats: { prompt: options.prompt },
    },
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
  function publishSidecars(threads: DiscussionThread[]) {
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
  }
  function publish(threads: DiscussionThread[]) {
    currentThreads = threads;
    if (!options.delaySidecars) publishSidecars(threads);
    applyDiscussionCatalogUpdate(fixture.models.discussionCatalog("parent-1"), "parent-1", {
      _tag: "Snapshot",
      revision: ++revision,
      parentSessionId: "parent-1",
      threads,
    });
  }
  publish(options.threads ?? []);
  if (options.metadata) {
    const catalog = fixture.models.discussionCatalog("parent-1");
    catalog.metadataLoaded = true;
    catalog.metadata.push(
      ...options.metadata.map((item) => ({
        id: item.id,
        title: item.title || "Side chat",
        sidecarSessionId: item.sidecarSessionId,
        parentSessionId: item.parentSessionId,
        workingDirectory: item.workingDirectory,
        status: item.status,
        running: false,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    );
  }
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
      <VirtuosoMockContext.Provider
        value={options.transcriptViewport ? { viewportHeight: 1200, itemHeight: 100 } : undefined}
      >
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
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    root: fixture.root,
    session,
    resolutions,
    publish(threads: DiscussionThread[]) {
      act(() => publish(threads));
    },
    publishSidecars(threads: DiscussionThread[]) {
      act(() => publishSidecars(threads));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Secondary conversation workflows", () => {
  it("opens a metadata-only existing chat and accepts a reply while its parent stays streaming", async () => {
    const existing = { ...thread("cold", "Question"), title: "Question" };
    const listing = deferred<DiscussionThread[]>();
    const list = vi.fn<Client["discussionSessions"]["list"]>(() => listing.promise);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000002"),
    );
    using fixture = renderSideChats(vi.fn<Client["discussionSessions"]["start"]>(), {
      metadata: [existing],
      list,
      prompt,
      streaming: true,
      delaySidecars: true,
    });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Question" }));
    expect(screen.queryByLabelText("Open side chats")).toBeNull();
    expect(
      within(screen.getByRole("complementary", { name: "Side chat" })).getByRole("status")
        .textContent,
    ).toBe("Side chat exists. Opening…");
    // The explicit read recovers a missing catalog; linking still precedes the live snapshot.
    await act(async () => listing.resolve([existing]));
    expect(screen.queryByRole("combobox", { name: "Reply to side chat" })).toBeNull();
    fixture.publishSidecars([existing]);
    const reply = await screen.findByRole("combobox", { name: "Reply to side chat" });
    await fixture.user.type(reply, "Here is my response");
    await fixture.user.click(
      within(screen.getByRole("complementary", { name: "Question" })).getByRole("button", {
        name: "Send",
      }),
    );
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt.mock.calls[0]![0]).toMatchObject({
      sessionId: existing.sidecarSessionId,
      text: "Here is my response",
    });
    expect(fixture.session.isStreaming).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("waits for late sidecar linking and does not reopen a cancelled opening", async () => {
    const linked = { ...thread("link", "Linked chat"), title: "Linked chat" };
    const listing = deferred<DiscussionThread[]>();
    const list = vi.fn<Client["discussionSessions"]["list"]>(() => listing.promise);
    using fixture = renderSideChats(vi.fn<Client["discussionSessions"]["start"]>(), {
      threads: [{ ...linked, sidecarSessionId: undefined }],
      metadata: [linked],
      list,
      streaming: true,
    });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Linked chat" }));
    expect(
      within(screen.getByRole("complementary", { name: "Side chat" })).getByRole("status")
        .textContent,
    ).toBe("Side chat exists. Opening…");
    await fixture.user.click(screen.getByRole("button", { name: "Close side chat" }));
    fixture.publish([linked]);
    await act(async () => listing.resolve([linked]));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Linked chat" }));
    expect(await screen.findByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
  });

  it("opens automatically when an unlinked catalog row gains its sidecar", async () => {
    const linked = { ...thread("late", "Late link"), title: "Late link" };
    const unlinked = { ...linked, sidecarSessionId: undefined };
    const list = vi.fn<Client["discussionSessions"]["list"]>(async () => [unlinked]);
    using fixture = renderSideChats(vi.fn<Client["discussionSessions"]["start"]>(), {
      threads: [unlinked],
      metadata: [linked],
      list,
      streaming: true,
    });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Late link" }));
    expect(
      within(screen.getByRole("complementary", { name: "Side chat" })).getByRole("status")
        .textContent,
    ).toBe("Side chat exists. Opening…");
    fixture.publish([linked]);
    expect(await screen.findByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
  });

  it("replaces prolonged opening feedback with a bounded retry message", async () => {
    const existing = { ...thread("slow", "Slow chat"), title: "Slow chat" };
    using fixture = renderSideChats(vi.fn<Client["discussionSessions"]["start"]>(), {
      threads: [existing],
      delaySidecars: true,
    });
    const timers = vi.spyOn(globalThis, "setTimeout");
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Slow chat" }));
    const deadline = timers.mock.calls.find((call) => call[1] === 10_000)?.[0];
    expect(typeof deadline).toBe("function");
    act(() => {
      if (typeof deadline === "function") deadline();
    });
    expect(
      within(screen.getByRole("complementary", { name: "Side chat" })).getByRole("status")
        .textContent,
    ).toBe("Side chat exists, but is not ready to open. Retry opening or close and try again.");
    await fixture.user.click(screen.getByRole("button", { name: "Close side chat" }));
    fixture.publishSidecars([existing]);
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
  });

  it("preserves an opening failure and retries without creating a chat", async () => {
    const existing = { ...thread("retry", "Retry chat"), title: "Retry chat" };
    const list = vi
      .fn<Client["discussionSessions"]["list"]>()
      .mockRejectedValueOnce(new Error("Cannot read sidecar: permission denied"))
      .mockResolvedValueOnce([existing]);
    const start = vi.fn<Client["discussionSessions"]["start"]>();
    using fixture = renderSideChats(start, { metadata: [existing], list });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Retry chat" }));
    expect(await screen.findByText("Cannot read sidecar: permission denied")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Retry opening" }));
    fixture.publishSidecars([existing]);
    expect(await screen.findByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)(
    "handles catalog delivery %s the start receipt",
    async (order) => {
      const created = thread("ordered", "Ordered chat");
      const started = deferred<Awaited<ReturnType<Client["discussionSessions"]["start"]>>>();
      const start = vi.fn<Client["discussionSessions"]["start"]>(() => started.promise);
      using fixture = renderSideChats(start, { streaming: true });
      const input = screen.getByRole("combobox", { name: "Message" });
      await fixture.user.type(input, "/sidechat Ordered chat");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      expect(
        within(screen.getByRole("complementary", { name: "Side chat" })).getByRole("status")
          .textContent,
      ).toBe("Creating side chat…");
      if (order === "before") fixture.publish([created]);
      await act(async () =>
        started.resolve({
          thread: created,
          turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
        }),
      );
      if (order === "after") fixture.publish([created]);
      expect(await screen.findByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
      expect(input).toHaveProperty("value", "");
      expect(start).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps exact creation errors and the command for retry", async () => {
    const start = vi
      .fn<Client["discussionSessions"]["start"]>()
      .mockRejectedValue(new Error("Could not prepare sidecar: disk is full"));
    using fixture = renderSideChats(start);
    const input = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.type(input, "/sidechat Explain");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Could not prepare sidecar: disk is full")).toBeDefined();
    expect(input).toHaveProperty("value", "/sidechat Explain");
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
  });

  it("does not let an old draft submission take over a newly opened bare draft", async () => {
    const created = thread("old-draft", "Old draft");
    const started = deferred<Awaited<ReturnType<Client["discussionSessions"]["start"]>>>();
    const start = vi.fn<Client["discussionSessions"]["start"]>(() => started.promise);
    using fixture = renderSideChats(start);
    const input = screen.getByRole("combobox", { name: "Message" });
    const openBare = async () => {
      await fixture.user.type(input, "/sidechat ");
      await fixture.user.keyboard("{Escape}");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      return screen.getByRole("combobox", { name: "Message side chat" });
    };
    await fixture.user.type(await openBare(), "Original question");
    await fixture.user.click(
      within(screen.getByRole("complementary", { name: "Side chat" })).getByRole("button", {
        name: "Send",
      }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Close side chat" }));
    const draft = await openBare();
    await fixture.user.type(draft, "New question");
    await act(async () =>
      started.resolve({
        thread: created,
        turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
      }),
    );
    fixture.publish([created]);
    expect(screen.getByRole("combobox", { name: "Message side chat" })).toBe(draft);
    expect(draft).toHaveProperty("value", "New question");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not let a closed creation hijack a subsequent existing-chat opening", async () => {
    const created = thread("cancelled", "Cancelled launch");
    const existing = thread("existing", "Existing chat");
    const started = deferred<Awaited<ReturnType<Client["discussionSessions"]["start"]>>>();
    const start = vi.fn<Client["discussionSessions"]["start"]>(() => started.promise);
    using fixture = renderSideChats(start, { threads: [existing] });
    const input = screen.getByRole("combobox", { name: "Message" });
    await fixture.user.type(input, "/sidechat Explain");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await fixture.user.click(screen.getByRole("button", { name: "Close side chat" }));
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: "Existing chat" }));
    const draft = await screen.findByRole("combobox", { name: "Reply to side chat" });
    await fixture.user.type(draft, "New draft");
    await act(async () =>
      started.resolve({
        thread: created,
        turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
      }),
    );
    fixture.publish([existing, created]);
    expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBe(draft);
    expect(draft).toHaveProperty("value", "New draft");
    expect(start).toHaveBeenCalledTimes(1);
  });
  it.each([416, 1200])(
    "switches side chat tabs without resolving or losing drafts/transcripts at %ipx",
    async (width) => {
      availableWidth = width;
      const withTranscript = (id: string, title: string, text: string): DiscussionThread => {
        const base = thread(id, title);
        return {
          ...base,
          parts: [
            ...base.parts,
            { id: `${id}-answer`, kind: "text", role: "assistant", text, status: "complete" },
          ],
        };
      };
      const first = withTranscript("first", "First discussion", "First transcript");
      const second = withTranscript("second", "Second discussion", "Second transcript");
      using fixture = renderSideChats(vi.fn<Client["discussionSessions"]["start"]>(), {
        threads: [first, second],
        transcriptViewport: true,
      });
      // Establish a reading position before each virtual transcript mounts in jsdom.
      act(() => {
        for (const id of ["first", "second"])
          fixture.root.reviewsStore
            .chatStore(id)!
            .transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
      });
      const mainInput = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
      await fixture.user.type(mainInput, "Main draft");
      await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
      await fixture.user.click(screen.getByRole("button", { name: "First discussion" }));
      const sideChatStore = fixture.session.conversationSessionStore.sideChatStore;
      const firstChat = sideChatStore.target!.chatStore!;
      act(() => firstChat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" }));
      const tabs = within(screen.getByRole("tablist", { name: "Side chats" }));
      expect(tabs.getAllByRole("tab")).toHaveLength(2);
      expect(
        tabs.getByRole("tab", { name: "First discussion" }).getAttribute("aria-selected"),
      ).toBe("true");
      let content = screen.getByRole("tabpanel", { name: "First discussion" });
      expect(firstChat.parts.map((part) => (part.kind === "text" ? part.text : ""))).toContain(
        "First transcript",
      );
      expect(await within(content).findByText("First transcript")).toBeDefined();
      await fixture.user.type(within(content).getByRole("combobox"), "First draft");
      await fixture.user.click(tabs.getByRole("tab", { name: "Second discussion" }));
      content = screen.getByRole("tabpanel", { name: "Second discussion" });
      const secondChat = sideChatStore.target!.chatStore!;
      act(() => secondChat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" }));
      expect(await within(content).findByText("Second transcript")).toBeDefined();
      expect(within(content).queryByText("First transcript")).toBeNull();
      expect(within(content).getByRole("combobox")).toHaveProperty("value", "");
      await fixture.user.type(within(content).getByRole("combobox"), "Second draft");
      expect(screen.getAllByRole("complementary", { name: "Side chat" })).toHaveLength(1);
      expect(fixture.resolutions).not.toHaveBeenCalled();
      await fixture.user.click(tabs.getByRole("tab", { name: "First discussion" }));
      content = screen.getByRole("tabpanel", { name: "First discussion" });
      expect(await within(content).findByText("First transcript")).toBeDefined();
      expect(within(content).getByRole("combobox")).toHaveProperty("value", "First draft");
      expect(firstChat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
      const layout = content.closest('[data-slot="side-chat-layout"]')!;
      act(() => {
        availableWidth = width === 416 ? 1200 : 416;
        resizeLayout();
      });
      expect(
        screen.getByRole("tab", { name: "First discussion" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(layout.getAttribute("data-presentation")).toBe(
        width === 416 ? "side-by-side" : "replacement",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Close side chat" }));
      expect(screen.queryByRole("tablist", { name: "Side chats" })).toBeNull();
      expect(mainInput.value).toBe("Main draft");
      expect(fixture.resolutions).not.toHaveBeenCalled();
      await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
      await fixture.user.click(screen.getByRole("button", { name: "Second discussion" }));
      expect(screen.getByRole("tabpanel", { name: "Second discussion" })).toBeDefined();
      expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toHaveProperty(
        "value",
        "Second draft",
      );
      expect(secondChat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
      await fixture.user.click(screen.getByRole("button", { name: "Close and resolve" }));
      expect(fixture.resolutions).toHaveBeenCalledTimes(1);
      expect(sideChatStore.target?.chatStore).toBe(firstChat);
      expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toHaveProperty(
        "value",
        "First draft",
      );
      expect(screen.queryByRole("tablist", { name: "Side chats" })).toBeNull();
    },
  );
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
      expect(screen.queryByRole("tablist", { name: "Side chats" })).toBeNull();
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
      expect(
        within(screen.getByRole("complementary", { name: "Side chat" })).getByRole("status")
          .textContent,
      ).toBe("Side chat exists. Opening…");
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

  it("resolves only the selected thread and activates the remaining side chat", async () => {
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
    expect(screen.getByRole("complementary", { name: "Side chat" })).toBeDefined();
    expect(
      fixture.session.conversationSessionStore.sideChatStore.target?.navigationTarget,
    ).toMatchObject({
      threadId: "first",
    });
    expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Close and resolve" }));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
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
