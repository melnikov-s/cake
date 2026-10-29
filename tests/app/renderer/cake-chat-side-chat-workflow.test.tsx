/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type {
  DiscussionSessionTarget,
  CakeChatSideChatStartInput,
  DiscussionThread,
} from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { ChatTranscriptBehavior } from "../../../src/renderer/components/chat-transcript";
import { cakeChatTranscriptBehaviorFor } from "../../../src/renderer/lib/cake-chat-transcript-behavior";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import type { CakeChatSessionStore } from "../../../src/renderer/stores/CakeChatSessionStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

/** The Cake Chat pane's side chat composition, as `cake-chat-surface` assembles it. */
const Surface = observer(function Surface({
  chat,
  behavior,
}: {
  chat: CakeChatSessionStore;
  behavior?: ChatTranscriptBehavior;
}) {
  return (
    <>
      <SideChatsMenu store={chat} />
      <SideChatLayout
        store={chat.conversationSessionStore.sideChatStore}
        renderChat={(store) => <Chat store={store} embedded composerFocusEnabled={false} />}
      >
        <Chat
          store={chat.conversationSessionStore.chatStore}
          transcriptBehavior={behavior ?? { messageComments: chat.messageCommentsStore }}
          embedded
          composerFocusEnabled={false}
        />
      </SideChatLayout>
    </>
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
afterEach(cleanup);

function mergeFixture(
  merge: (input: DiscussionSessionTarget) => Promise<{ importedMessages: number }>,
) {
  const fixture = createRendererStoreFixture({
    client: {
      cakeChats: { open: async () => undefined },
      discussionSessions: { merge },
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
  return Object.assign(fixture, { chat, side });
}

it("merges an idle side chat explicitly, keeps it usable, and reports repeated imports", async () => {
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
    <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
      <Surface chat={fixture.chat} />
    </VirtuosoMockContext.Provider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Merge into main chat" }));
  expect(merge).toHaveBeenCalledTimes(1);
  expect(merge.mock.calls[0]![0]).toEqual({
    parentSessionId: CAKE_CHAT_SESSION_ID,
    workingDirectory: "/home",
    threadId: "merge-thread",
  });
  expect((screen.getByRole("button", { name: "Merging…" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => finish({ importedMessages: 2 }));
  expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Merge into main chat" }));
  expect(await screen.findByRole("button", { name: "Already merged" })).toBeDefined();
  expect(merge).toHaveBeenCalledTimes(2);
  act(() =>
    applyConversationSnapshot(
      fixture.side,
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
        {
          id: "new-side-answer",
          kind: "text",
          role: "assistant",
          text: "Another answer",
          status: "complete",
        },
      ]),
    ),
  );
  await user.click(await screen.findByRole("button", { name: "Merge into main chat" }));
  expect(merge).toHaveBeenCalledTimes(3);
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
    <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
      <Surface
        chat={fixture.chat}
        behavior={cakeChatTranscriptBehaviorFor(fixture.root, fixture.chat)}
      />
    </VirtuosoMockContext.Provider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Merge into main chat" }));
  await user.click(screen.getByRole("button", { name: "Close Side chat" }));
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
  expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Merge into main chat" })).toBeDefined();
  view.unmount();
});

it("disables merge while either conversation is busy and permits retry after failure", async () => {
  const merge = vi
    .fn<(input: DiscussionSessionTarget) => Promise<{ importedMessages: number }>>()
    .mockRejectedValueOnce(new Error("Import failed"))
    .mockResolvedValueOnce({ importedMessages: 2 });
  using fixture = mergeFixture(merge);
  const view = render(<Surface chat={fixture.chat} />);
  const user = userEvent.setup();
  const button = () =>
    screen.getByRole("button", { name: "Merge into main chat" }) as HTMLButtonElement;
  act(() => {
    fixture.chat.model.streaming = true;
  });
  await waitFor(() => expect(button().disabled).toBe(true));
  await user.click(button());
  expect(merge).not.toHaveBeenCalled();
  act(() => {
    fixture.chat.model.streaming = false;
    fixture.side.activeTurnIds.push("accepted-side-turn");
  });
  await waitFor(() => expect(button().disabled).toBe(true));
  act(() => {
    fixture.side.activeTurnIds.length = 0;
  });
  await waitFor(() => expect(button().disabled).toBe(false));
  await user.click(button());
  expect(await screen.findByText("Import failed")).toBeDefined();
  await user.click(button());
  await waitFor(() => expect(screen.queryByText("Import failed")).toBeNull());
  expect(merge).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
  view.unmount();
});

it("branches a side chat from a Cake Chat selection and returns to the main conversation", async () => {
  const thread: DiscussionThread = {
    id: "thread-1",
    workingDirectory: "/home",
    parentSessionId: CAKE_CHAT_SESSION_ID,
    sidecarSessionId: "sidecar-1",
    anchor: {
      path: `session:${CAKE_CHAT_SESSION_ID}/message/assistant-1`,
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
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { startSideChat, open: async () => undefined } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  act(() => {
    fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
    applyConversationSnapshot(
      chat.model,
      snapshot(CAKE_CHAT_SESSION_ID, [
        { id: "user-1", kind: "text", role: "user", text: "Compare my tasks", status: "complete" },
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
    <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
      <Surface chat={chat} />
    </VirtuosoMockContext.Provider>,
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
    chat.conversationSessionStore.sideChatStore.open({
      key: "selection-draft",
      title: "Side chat",
      eyebrow: () => "Selection",
      chatStore: chat.messageCommentsStore.draftChatStore,
    });
  });
  const draft = await screen.findByRole("combobox", { name: "Message about selected text" });
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
  // The side chat takes over once its catalog entry and sidecar conversation exist.
  act(() => {
    applyDiscussionCatalogUpdate(
      fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID),
      CAKE_CHAT_SESSION_ID,
      {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: CAKE_CHAT_SESSION_ID,
        threads: [{ ...thread, parts: sidecarParts }],
      },
    );
    applyConversationSnapshot(
      fixture.models.discussionConversation("sidecar-1", "/home", CAKE_CHAT_SESSION_ID),
      snapshot("sidecar-1", sidecarParts),
    );
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

  // Closing returns to the main conversation; the header menu reopens the side chat.
  await user.click(screen.getByRole("button", { name: "Close Side chat" }));
  expect(chat.conversationSessionStore.sideChatStore.target).toBeUndefined();
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
  await user.click(await screen.findByRole("button", { name: /first task/ }));
  expect(chat.conversationSessionStore.sideChatStore.target?.key).toBe("discussion:thread-1");
  view.unmount();
});
