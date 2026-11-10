/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { observer, StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type {
  DiscussionSessionTarget,
  CakeChatSideChatStartInput,
  DiscussionThread,
} from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import type { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { ChatTranscriptBehavior } from "../../../src/renderer/components/chat-transcript";
import { cakeChatTranscriptBehaviorFor } from "../../../src/renderer/lib/cake-chat-transcript-behavior";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { ConversationFocusContext } from "../../../src/renderer/lib/conversation-focus-context";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import type { CakeChatSessionStore } from "../../../src/renderer/stores/CakeChatSessionStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { ReviewThread } from "../../../src/renderer/models/ReviewThread";

/** The Cake Chat pane's side chat composition, as `cake-chat-surface` assembles it. */
const Surface = observer(function Surface({
  chat,
  behavior,
}: {
  chat: CakeChatSessionStore;
  behavior?: ChatTranscriptBehavior;
}) {
  return (
    <ConversationFocusContext.Provider value>
      <SideChatsMenu store={chat} />
      <SideChatLayout
        store={chat.conversationSessionStore.sideChatStore}
        renderChat={(store, composerHeader) => (
          <Chat
            store={store}
            composerHeader={composerHeader}
            embedded
            composerFocusEnabled={false}
          />
        )}
      >
        <Chat
          store={chat.conversationSessionStore.chatStore}
          transcriptBehavior={behavior ?? { messageComments: chat.messageCommentsStore }}
          embedded
          composerFocusEnabled={false}
        />
      </SideChatLayout>
    </ConversationFocusContext.Provider>
  );
});

const snapshot = (sessionId: string, parts: unknown[]) => ({
  sessionId,
  sessionFile: `/${sessionId}.sqlite`,
  parts: parts as never,
  model: { provider: "anthropic", id: "claude", name: "Claude" },
  models: [],
  thinkingLevel: "high" as const,
  availableThinkingLevels: ["off", "high"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

beforeEach(() => {
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const rect = measure.call(this);
      return this.getAttribute("data-slot") === "side-chat-layout"
        ? { ...rect, width: 1200 }
        : rect;
    },
  );
  // The opened thread highlights its passage, which measures the text range.
  const rect = { top: 80, right: 220, bottom: 100, left: 120, width: 100, height: 20 } as DOMRect;
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [rect],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mergeFixture(
  merge: (input: DiscussionSessionTarget) => Promise<{ importedMessages: number }>,
) {
  const setResolved = vi.fn<Client["discussionSessions"]["setResolved"]>(async (input) => {
    const thread = fixture.models
      .discussionCatalog(CAKE_CHAT_SESSION_ID)
      .threads.find((thread) => thread.id === input.threadId);
    if (!thread) throw new Error("Missing side chat");
    act(() => {
      thread.status = "resolved";
    });
    return { ...thread, parts: [], status: "resolved" };
  });
  const fixture = createRendererStoreFixture({
    client: {
      cakeChats: { open: async () => undefined },
      discussionSessions: {
        merge: async (input) => {
          const result = await merge(input);
          const catalog = fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID);
          act(() => {
            const thread = catalog.threads.find((thread) => thread.id === input.threadId);
            if (thread) thread.status = "resolved";
          });
          return result;
        },
        setResolved,
      },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const side = fixture.models.discussionConversation("merge-side", "/home", CAKE_CHAT_SESSION_ID);
  fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
  applyConversationSnapshot(
    chat.model,
    snapshot(CAKE_CHAT_SESSION_ID, [
      {
        id: "parent-answer",
        kind: "text",
        role: "assistant",
        text: "Main answer",
        status: "complete",
      },
    ]),
  );
  applyDiscussionCatalogUpdate(
    fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID),
    CAKE_CHAT_SESSION_ID,
    {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: CAKE_CHAT_SESSION_ID,
      threads: [
        {
          id: "merge-thread",
          workingDirectory: "/home",
          parentSessionId: CAKE_CHAT_SESSION_ID,
          sidecarSessionId: "merge-side",
          anchor: {
            path: "session:main",
            view: "session",
            start: { diffLine: 0 },
            end: { diffLine: 0 },
            selectedText: "",
            contextBefore: "",
            contextAfter: "",
            diff: "",
          },
          parts: [],
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  );
  applyConversationSnapshot(
    side,
    snapshot("merge-side", [
      {
        id: "side-question",
        kind: "text",
        role: "user",
        text: "Side question",
        status: "complete",
      },
      {
        id: "side-answer",
        kind: "text",
        role: "assistant",
        text: "Side answer",
        status: "complete",
      },
    ]),
  );
  chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  chat.openSideChat("merge-thread");
  return Object.assign(fixture, { chat, side, setResolved });
}

function addMergeSibling(fixture: ReturnType<typeof mergeFixture>, id: string, title: string) {
  const catalog = fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID);
  catalog.threads.push(
    ReviewThread.create({
      ...toSnapshot(catalog.threads[0]!),
      id,
      title,
      sidecarSessionId: `${id}-side`,
      parts: [],
    }),
  );
  applyConversationSnapshot(
    fixture.models.discussionConversation(`${id}-side`, "/home", CAKE_CHAT_SESSION_ID),
    snapshot(`${id}-side`, []),
  );
}

it.each(["Merge into main chat", "Close and resolve"])(
  "%s activates a remaining tab until the last tab is removed",
  async (action) => {
    const merge = vi.fn(async () => ({ importedMessages: 2 }));
    using fixture = mergeFixture(merge);
    addMergeSibling(fixture, "second-thread", "Second chat");
    addMergeSibling(fixture, "third-thread", "Third chat");
    const panel = fixture.chat.conversationSessionStore.sideChatStore;
    fixture.chat.openSideChat("second-thread");
    fixture.chat.sideChats.chatStore("third-thread")!.setDraft("Preserved draft");
    const view = render(
      <StoreProvider store={fixture.root}>
        <Surface chat={fixture.chat} />
      </StoreProvider>,
    );
    const user = userEvent.setup();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: action }));
    expect(panel.target?.navigationTarget).toMatchObject({ threadId: "merge-thread" });
    expect(screen.getByRole("tab", { name: "Side chat" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByRole("tab", { name: "Second chat" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: action }));
    expect(panel.target?.navigationTarget).toMatchObject({ threadId: "third-thread" });
    expect(screen.getByRole("complementary", { name: "Third chat" })).toBeDefined();
    expect(screen.queryByRole("tablist", { name: "Side chats" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toHaveProperty(
      "value",
      "Preserved draft",
    );
    await user.click(screen.getByRole("button", { name: action }));
    expect(panel.target).toBeUndefined();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(
      fixture.models
        .discussionCatalog(CAKE_CHAT_SESSION_ID)
        .threads.every((thread) => thread.status === "resolved"),
    ).toBe(true);
    expect(merge).toHaveBeenCalledTimes(action === "Merge into main chat" ? 3 : 0);
    expect(fixture.setResolved).toHaveBeenCalledTimes(action === "Close and resolve" ? 3 : 0);
    view.unmount();
  },
);

it.each(["Merge into main chat", "Close and resolve"])(
  "%s keeps both tabs and the active selection while pending or failed",
  async (action) => {
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const merge = vi.fn(async () => ({ importedMessages: 2 }));
    using fixture = mergeFixture(merge);
    addMergeSibling(fixture, "second-thread", "Second chat");
    if (action === "Merge into main chat") {
      merge.mockImplementationOnce(async () => {
        await pending;
        return { importedMessages: 2 };
      });
    } else {
      fixture.setResolved.mockImplementationOnce(async () => {
        await pending;
        throw new Error("Expected rejection");
      });
    }
    const panel = fixture.chat.conversationSessionStore.sideChatStore;
    const original = panel.target;
    const view = render(
      <StoreProvider store={fixture.root}>
        <Surface chat={fixture.chat} />
      </StoreProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: action }));
    expect(panel.target).toBe(original);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Side chat" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Close and resolve" }).disabled,
    ).toBe(true);
    await act(async () => fail(new Error("Action failed")));
    expect(panel.target).toBe(original);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Side chat" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      fixture.models
        .discussionCatalog(CAKE_CHAT_SESSION_ID)
        .threads.every((thread) => thread.status === "open"),
    ).toBe(true);
    expect(
      screen.getByText(
        action === "Merge into main chat"
          ? "Action failed"
          : "Could not resolve side chat. Try again.",
      ),
    ).toBeDefined();
    await user.click(screen.getByRole("button", { name: action }));
    expect(panel.target?.navigationTarget).toMatchObject({ threadId: "second-thread" });
    expect(screen.getByRole("complementary", { name: "Second chat" })).toBeDefined();
    view.unmount();
  },
);

it("switches Cake Chat side tabs through the existing owner without resolving", async () => {
  const merge = vi.fn(async () => ({ importedMessages: 0 }));
  using fixture = mergeFixture(merge);
  const catalog = fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID);
  catalog.threads[0]!.title = "First chat";
  catalog.threads.push(
    ReviewThread.create({
      ...toSnapshot(catalog.threads[0]!),
      id: "second-thread",
      title: "Second chat",
      sidecarSessionId: "second-side",
      parts: [],
    }),
  );
  catalog.threads.push(
    ReviewThread.create({
      ...toSnapshot(catalog.threads[0]!),
      id: "resolved-thread",
      sidecarSessionId: "resolved-side",
      title: "Resolved chat",
      status: "resolved",
    }),
    ReviewThread.create({
      ...toSnapshot(catalog.threads[0]!),
      id: "code-thread",
      sidecarSessionId: "code-side",
      title: "Code discussion",
      anchor: { ...catalog.threads[0]!.anchor, view: "file" },
    }),
  );
  applyConversationSnapshot(
    fixture.models.discussionConversation("second-side", "/home", CAKE_CHAT_SESSION_ID),
    snapshot("second-side", []),
  );
  const view = render(
    <StoreProvider store={fixture.root}>
      <Surface chat={fixture.chat} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(screen.queryByRole("tab", { name: "Resolved chat" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Code discussion" })).toBeNull();
  const input = screen.getByRole("combobox", { name: "Reply to side chat" });
  await user.type(input, "First draft");
  await user.click(screen.getByRole("tab", { name: "Second chat" }));
  expect(
    fixture.chat.conversationSessionStore.sideChatStore.target?.navigationTarget,
  ).toMatchObject({ kind: "side-chat", threadId: "second-thread" });
  expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toHaveProperty("value", "");
  await user.type(screen.getByRole("combobox", { name: "Reply to side chat" }), "Second draft");
  await user.click(screen.getByRole("tab", { name: "First chat" }));
  expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toHaveProperty(
    "value",
    "First draft",
  );
  await user.click(screen.getByRole("button", { name: "Close side chat" }));
  expect(fixture.setResolved).not.toHaveBeenCalled();
  expect(merge).not.toHaveBeenCalled();
  expect(catalog.threads.find((thread) => thread.id === "merge-thread")?.status).toBe("open");
  expect(catalog.threads.find((thread) => thread.id === "second-thread")?.status).toBe("open");
  view.unmount();
});

it("merges an idle side chat explicitly and closes only after successful resolution", async () => {
  let finish!: (result: { importedMessages: number }) => void;
  const merge = vi
    .fn<(input: DiscussionSessionTarget) => Promise<{ importedMessages: number }>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ importedMessages: 0 })
    .mockResolvedValueOnce({ importedMessages: 1 });
  using fixture = mergeFixture(merge);
  const view = render(
    <StoreProvider store={fixture.root}>
      <>
        <Surface chat={fixture.chat} />
      </>
    </StoreProvider>,
  );
  const user = userEvent.setup();
  const panel = screen.getByRole("complementary", { name: "Side chat" });
  const actionRow = panel.querySelector<HTMLElement>(
    '[data-slot="composer-dock"] [data-slot="side-chat-actions"]',
  );
  expect(actionRow).not.toBeNull();
  const header = panel.querySelector<HTMLElement>(":scope > header");
  expect(header).not.toBeNull();
  expect(within(header!).getByRole("button", { name: "Close side chat" })).toBeDefined();
  const close = within(actionRow!).getByRole<HTMLButtonElement>("button", {
    name: "Close and resolve",
  });
  expect(close.textContent).toBe("Close and resolve");
  expect(within(actionRow!).getAllByRole("button")).toHaveLength(2);
  expect(
    within(actionRow!).getByRole("button", { name: "Merge into main chat" }).querySelector("svg"),
  ).not.toBeNull();
  expect(close.querySelector("svg")).not.toBeNull();
  await user.click(within(actionRow!).getByRole("button", { name: "Merge into main chat" }));
  expect(merge).toHaveBeenCalledTimes(1);
  expect(merge.mock.calls[0]![0]).toEqual({
    parentSessionId: CAKE_CHAT_SESSION_ID,
    workingDirectory: "/home",
    threadId: "merge-thread",
  });
  expect((screen.getByRole("button", { name: "Merging…" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "Merging…" }));
  expect(merge).toHaveBeenCalledTimes(1);
  expect(close.disabled).toBe(true);
  await user.click(close);
  expect(fixture.setResolved).not.toHaveBeenCalled();
  expect(fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID).threads[0]?.status).toBe("open");
  await act(async () => finish({ importedMessages: 2 }));
  expect(fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID).threads[0]?.status).toBe(
    "resolved",
  );
  expect(screen.queryByRole("button", { name: /^Side chats, / })).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
  expect(fixture.chat.conversationSessionStore.sideChatStore.target).toBeUndefined();
  expect(
    fixture.side.parts.some((part) => part.kind === "text" && part.text === "Side answer"),
  ).toBe(true);
  view.unmount();
});

it("resolves and closes a successful no-new-dialogue merge too", async () => {
  const merge = vi.fn(async () => ({ importedMessages: 0 }));
  using fixture = mergeFixture(merge);
  const view = render(
    <StoreProvider store={fixture.root}>
      <Surface chat={fixture.chat} />
    </StoreProvider>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Merge into main chat" }));
  expect(fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID).threads[0]?.status).toBe(
    "resolved",
  );
  expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
  expect(fixture.side.parts).toHaveLength(2);
  view.unmount();
});

it("closes and resolves from the action area without merging or losing the source dialogue", async () => {
  const merge = vi.fn(async () => ({ importedMessages: 2 }));
  using fixture = mergeFixture(merge);
  const view = render(
    <StoreProvider store={fixture.root}>
      <Surface chat={fixture.chat} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  const actions = screen.getByRole("group", { name: "Side chat actions" });
  await user.click(within(actions).getByRole("button", { name: "Close and resolve" }));
  expect(merge).not.toHaveBeenCalled();
  expect(fixture.setResolved).toHaveBeenCalledWith(
    {
      parentSessionId: CAKE_CHAT_SESSION_ID,
      workingDirectory: "/home",
      threadId: "merge-thread",
      resolved: true,
    },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Side chats, / })).toBeNull();
  expect(fixture.side.parts).toMatchObject([
    { id: "merge-side:side-question", role: "user", text: "Side question" },
    { id: "merge-side:side-answer", role: "assistant", text: "Side answer" },
  ]);
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
  view.unmount();
});

it("appends collapsed attributed history with attachments and reopens its preserved source", async () => {
  const source = {
    groupId: "import-1",
    threadId: "merge-thread",
    title: "Side chat",
    sourceSessionId: "merge-side",
    sourceEntryId: "side-question",
    sourceTimestamp: Date.UTC(2026, 0, 1, 12),
    importedAt: Date.UTC(2026, 0, 1, 13),
  };
  const imported: UiPart[] = [
    {
      id: "import-question",
      kind: "text",
      role: "user",
      text: "Historical question",
      status: "complete",
      sideChatImport: source,
    },
    {
      id: "import-file",
      kind: "attachment",
      attachmentKind: "file",
      mediaType: "text/plain",
      name: "notes.txt",
      inputReference: {
        kind: "input",
        id: "00000000-0000-4000-8000-000000000001",
        name: "notes.txt",
        mimeType: "text/plain",
        byteLength: 12,
      },
      sideChatImport: source,
    },
    {
      id: "import-answer",
      kind: "text",
      role: "assistant",
      text: "Historical answer",
      status: "complete",
      sideChatImport: { ...source, sourceEntryId: "side-answer" },
    },
  ];
  const merge = vi.fn(async () => {
    publish();
    return { importedMessages: 2 };
  });
  using fixture = mergeFixture(merge);
  const publish = () =>
    applyConversationSnapshot(
      fixture.chat.model,
      snapshot(CAKE_CHAT_SESSION_ID, [
        {
          id: "parent-answer",
          kind: "text",
          role: "assistant",
          text: "Main answer",
          status: "complete",
        },
        ...imported,
      ]),
    );
  const view = render(
    <StoreProvider store={fixture.root}>
      <>
        <Surface
          chat={fixture.chat}
          behavior={cakeChatTranscriptBehaviorFor(fixture.root, fixture.chat)}
        />
      </>
    </StoreProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Merge into main chat" }));
  expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
  const disclosure = await screen.findByRole("button", {
    name: "Merged from Side chat 2 messages",
  });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Historical question")).toBeNull();
  expect(screen.getByText("Main answer")).toBeDefined();
  await user.click(disclosure);
  expect(await screen.findByText("Historical question")).toBeDefined();
  expect(screen.getByText("Historical answer")).toBeDefined();
  expect(screen.getByText("You")).toBeDefined();
  expect(screen.getByText("Assistant")).toBeDefined();
  expect(screen.getByRole("link", { name: "notes.txt" }).getAttribute("href")).toContain(
    "00000000-0000-4000-8000-000000000001",
  );
  const sourceLink = screen.getAllByRole("link", { name: "Source" })[0]!;
  expect(sourceLink.getAttribute("aria-description")).toContain("Original message");
  await user.click(sourceLink);
  expect(fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID).threads[0]?.status).toBe(
    "resolved",
  );
  expect(screen.queryByRole("button", { name: /^Side chats, / })).toBeNull();
  expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Merge into main chat" })).toBeDefined();
  view.unmount();
});

it.each(["parent", "source", "both"] as const)(
  "queues merge during %s activity, coalesces repeated clicks, then resolves and closes",
  async (activity) => {
    let finish!: (result: { importedMessages: number }) => void;
    const merge = vi.fn(
      () =>
        new Promise<{ importedMessages: number }>((resolve) => {
          finish = resolve;
        }),
    );
    using fixture = mergeFixture(merge);
    act(() => {
      fixture.chat.model.streaming = activity !== "source";
      if (activity !== "parent") fixture.side.activeTurnIds.push("side-turn");
    });
    const view = render(
      <StoreProvider store={fixture.root}>
        <Surface chat={fixture.chat} />
      </StoreProvider>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Merge into main chat" });
    expect(button.disabled).toBe(false);
    await user.click(button);
    const queued = screen.getByRole<HTMLButtonElement>("button", { name: "Merge queued…" });
    expect(queued.disabled).toBe(false);
    expect(queued.getAttribute("aria-busy")).toBe("true");
    await user.click(queued);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID).threads[0]?.status).toBe("open");
    expect(screen.getByRole("complementary", { name: "Side chat" })).toBeDefined();
    act(() => {
      fixture.chat.model.streaming = false;
      fixture.side.activeTurnIds.length = 0;
    });
    expect(await screen.findByRole("button", { name: "Merging…" })).toBeDefined();
    await act(async () => finish({ importedMessages: 2 }));
    expect(fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID).threads[0]?.status).toBe(
      "resolved",
    );
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    expect(merge).toHaveBeenCalledTimes(1);
    view.unmount();
  },
);

it("keeps merge available while busy and permits retry after failure without closing", async () => {
  const merge = vi
    .fn<(input: DiscussionSessionTarget) => Promise<{ importedMessages: number }>>()
    .mockRejectedValueOnce(new Error("Import failed"))
    .mockResolvedValueOnce({ importedMessages: 2 });
  using fixture = mergeFixture(merge);
  const view = render(
    <StoreProvider store={fixture.root}>
      <Surface chat={fixture.chat} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  const button = () =>
    screen.getByRole("button", { name: "Merge into main chat" }) as HTMLButtonElement;
  act(() => {
    fixture.chat.model.streaming = true;
  });
  await waitFor(() => expect(button().disabled).toBe(false));
  act(() => {
    fixture.chat.model.streaming = false;
    fixture.side.activeTurnIds.push("accepted-side-turn");
  });
  await waitFor(() => expect(button().disabled).toBe(false));
  act(() => {
    fixture.side.activeTurnIds.length = 0;
  });
  await waitFor(() => expect(button().disabled).toBe(false));
  await user.click(button());
  expect(await screen.findByText("Import failed")).toBeDefined();
  expect(fixture.setResolved).not.toHaveBeenCalled();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Close and resolve" }).disabled,
  ).toBe(false);
  expect(fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID).threads[0]?.status).toBe("open");
  await user.click(button());
  await waitFor(() => expect(screen.queryByText("Import failed")).toBeNull());
  expect(merge).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
  view.unmount();
});

it.each([CAKE_CHAT_SESSION_ID, `project-chat:${"1".repeat(64)}`])(
  "branches a side chat from %s and keeps its main conversation visible",
  async (parentSessionId) => {
    const thread: DiscussionThread = {
      id: "thread-1",
      workingDirectory: "/home",
      parentSessionId,
      sidecarSessionId: "sidecar-1",
      anchor: {
        path: `session:${parentSessionId}/message/assistant-1`,
        view: "message",
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "first task",
        contextBefore: "The ",
        contextAfter: " is larger.",
        diff: "",
        startOffset: 4,
        endOffset: 14,
        messageId: "assistant-1",
        entryId: "entry-1",
      },
      parts: [],
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const startSideChat = vi.fn<
      (input: CakeChatSideChatStartInput) => Promise<{ turnId: TurnId; thread: DiscussionThread }>
    >(async () => ({ turnId: "00000000-0000-4000-8000-000000000001" as TurnId, thread }));
    const setResolved = vi.fn<Client["discussionSessions"]["setResolved"]>(async () => {
      const resolved = { ...thread, status: "resolved" as const };
      act(() =>
        applyDiscussionCatalogUpdate(
          fixture.models.discussionCatalog(parentSessionId),
          parentSessionId,
          { _tag: "Snapshot", revision: 2, parentSessionId, threads: [resolved] },
        ),
      );
      return resolved;
    });
    using fixture = createRendererStoreFixture({
      client: {
        cakeChats: { startSideChat, open: async () => undefined },
        discussionSessions: { setResolved },
      },
    });
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId: parentSessionId, title: "Main chat" }],
    });
    const chat = fixture.root.cakeChatCollectionStore.registry.load(parentSessionId);
    act(() => {
      fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(parentSessionId);
      applyConversationSnapshot(
        chat.model,
        snapshot(parentSessionId, [
          {
            id: "user-1",
            kind: "text",
            role: "user",
            text: "Compare my tasks",
            status: "complete",
          },
          {
            id: "assistant-1",
            kind: "text",
            role: "assistant",
            entryId: "entry-1",
            text: "The first task is larger.",
            status: "complete",
          },
        ]),
      );
      chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
        kind: "top",
      });
    });
    const view = render(
      <StoreProvider store={fixture.root}>
        <>
          <Surface chat={chat} />
        </>
      </StoreProvider>,
    );
    const user = userEvent.setup();

    // Establish the selection draft the transcript context menu opens; native
    // text-selection initiation is covered by the transcript tests.
    act(() => {
      chat.messageCommentsStore.prepareDraft({
        messageId: "assistant-1",
        entryId: "entry-1",
        selectedText: "first task",
        startOffset: 4,
        endOffset: 14,
        contextBefore: "The ",
        contextAfter: " is larger.",
      });
      chat.messageCommentsStore.draftChatStore.transcriptInteraction.setTranscriptScrollPosition({
        kind: "top",
      });
      chat.conversationSessionStore.sideChatStore.open({
        key: "selection-draft",
        title: "Side chat",
        eyebrow: () => "Selection",
        chatStore: chat.messageCommentsStore.draftChatStore,
      });
    });
    const draft = await screen.findByRole("combobox", { name: "Message about selected text" });
    const panel = screen.getByRole("complementary", { name: "Side chat" });
    expect(await within(panel).findByText("first task")).toBeDefined();
    await user.type(draft, "Why is it larger?{Enter}");

    await waitFor(() => expect(startSideChat).toHaveBeenCalledTimes(1));
    const input = startSideChat.mock.calls[0]![0];
    expect(input.text).toBe("Why is it larger?");
    expect(input.model).toEqual({ provider: "anthropic", id: "claude" });
    expect(input.thinkingLevel).toBe("high");
    expect(input.anchor).toEqual(thread.anchor);

    const sidecarParts = [
      { id: "q", kind: "text", role: "user", text: "Why is it larger?", status: "complete" },
      { id: "a", kind: "text", role: "assistant", text: "More steps.", status: "complete" },
    ];
    // The draft becomes the live side chat beside the same main conversation.
    act(() => {
      applyDiscussionCatalogUpdate(
        fixture.models.discussionCatalog(parentSessionId),
        parentSessionId,
        {
          _tag: "Snapshot",
          revision: 1,
          parentSessionId,
          threads: [{ ...thread, parts: sidecarParts }],
        },
      );
      applyConversationSnapshot(
        fixture.models.discussionConversation("sidecar-1", "/home", parentSessionId),
        snapshot("sidecar-1", sidecarParts),
      );
      chat.sideChats
        .chatStore(thread.id)
        ?.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    });
    await waitFor(() =>
      expect(chat.conversationSessionStore.sideChatStore.target?.key).toBe("discussion:thread-1"),
    );
    expect(chat.sideChats.chatStore("thread-1")?.parts.map((part) => part.id)).toEqual([
      "anchor:thread-1",
      "q",
      "a",
    ]);
    expect(screen.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();
    expect(await within(panel).findByText("first task")).toBeDefined();
    expect(await within(panel).findByText("More steps.")).toBeDefined();
    const parentInputName =
      parentSessionId === CAKE_CHAT_SESSION_ID ? "Message Cake Chat" : "Message Project Chat";
    expect(screen.getByRole("combobox", { name: parentInputName })).toBeDefined();
    expect(screen.getByText("The first task is larger.")).toBeDefined();
    expect(screen.getByRole("separator", { name: "Resize side chat" })).toBeDefined();

    // Resolution removes the bubble entry, not the main conversation or the Pi dialogue.
    await user.click(screen.getByRole("button", { name: "Close and resolve" }));
    expect(setResolved).toHaveBeenCalledWith(
      { parentSessionId, workingDirectory: "/home", threadId: thread.id, resolved: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(chat.conversationSessionStore.sideChatStore.target).toBeUndefined();
    expect(screen.getByRole("combobox", { name: parentInputName })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Side chats, / })).toBeNull();
    expect(chat.sideChats.chatStore(thread.id)?.parts.map((part) => part.id)).toEqual([
      "anchor:thread-1",
      "q",
      "a",
    ]);
    view.unmount();
  },
);
