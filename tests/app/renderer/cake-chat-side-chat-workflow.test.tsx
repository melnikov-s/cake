/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-data";
import type {
  CakeChatSideChatStartInput,
  DiscussionThread,
} from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import type { CakeChatSessionStore } from "../../../src/renderer/stores/CakeChatSessionStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

/** The Cake Chat pane's side chat composition, as `cake-chat-surface` assembles it. */
const Surface = observer(function Surface({ chat }: { chat: CakeChatSessionStore }) {
  return (
    <>
      <SideChatsMenu store={chat} />
      <SideChatLayout
        store={chat.conversationSessionStore.sideChatStore}
        renderChat={(store) => <Chat store={store} embedded composerFocusEnabled={false} />}
      >
        <Chat
          store={chat.conversationSessionStore.chatStore}
          transcriptBehavior={{
            messageComments: chat.messageCommentsStore,
            onBranchSideChat: (message) => chat.branchSideChat(message),
          }}
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

afterEach(cleanup);

it("branches a side chat from a Cake Chat response and returns to the main conversation", async () => {
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
      selectedText: "",
      contextBefore: "",
      contextAfter: "",
      diff: "",
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

  await user.click(await screen.findByRole("button", { name: "Discuss response in side chat" }));
  const draft = await screen.findByRole("combobox", { name: "Message about this message" });
  await user.type(draft, "Why is it larger?{Enter}");

  await waitFor(() => expect(startSideChat).toHaveBeenCalledTimes(1));
  const input = startSideChat.mock.calls[0]![0];
  expect(input.text).toBe("Why is it larger?");
  expect(input.model).toEqual({ provider: "anthropic", id: "claude" });
  expect(input.thinkingLevel).toBe("high");
  // A whole-message branch has no passage offsets to highlight.
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
  expect(chat.sideChats.chatStore("thread-1")?.parts.map((part) => part.id)).toEqual(["q", "a"]);
  expect(screen.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();

  // Closing returns to the main conversation; the header menu reopens the side chat.
  await user.click(screen.getByRole("button", { name: "Close Side chat" }));
  expect(chat.conversationSessionStore.sideChatStore.target).toBeUndefined();
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
  await user.click(await screen.findByRole("button", { name: /Why is it larger\?/ }));
  expect(chat.conversationSessionStore.sideChatStore.target?.key).toBe("discussion:thread-1");
  view.unmount();
});
