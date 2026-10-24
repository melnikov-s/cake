/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import type { CakeChatSessionStore } from "../../../src/renderer/stores/CakeChatSessionStore";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const scopes = [
  ["global Cake Chat", CAKE_CHAT_SESSION_ID],
  ["Project Chat", `project-chat:${"a".repeat(64)}`],
] as const;
const cursor = JSON.stringify({ olderThan: 220 });
const olderCursor = JSON.stringify({ olderThan: 100 });
const textPart = (id: string, text: string): Extract<UiPart, { kind: "text" }> => ({
  id,
  entryId: id.split("-")[1],
  kind: "text",
  role: "user",
  text,
  status: "complete",
});
const recent = textPart("entry-220-text", "Recent side-chat original");
const older = textPart("entry-100-text", "Older side-chat original");
const oldest = textPart("entry-1-text", "Oldest side-chat original");

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
          embedded
          composerFocusEnabled={false}
        />
      </SideChatLayout>
    </>
  );
});

function renderHistory(
  parentSessionId: string,
  history: Client["sessionChats"]["history"],
  paginated = true,
) {
  const abort = vi.fn<Client["sessionChats"]["abort"]>();
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    client: { cakeChats: { open: async () => undefined }, sessionChats: { history, abort } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: parentSessionId,
        title: "Chat",
        ...(parentSessionId === CAKE_CHAT_SESSION_ID ? {} : { projectPath: "/project" }),
      },
    ],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(parentSessionId);
  fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(parentSessionId);
  const sidecarSessionId = paginated
    ? cakeChatSideChatSessionId(2, parentSessionId)
    : "regular-pi-sidecar";
  const thread: DiscussionThread = {
    id: "history-thread",
    parentSessionId,
    sidecarSessionId,
    workingDirectory: "/project",
    anchor: {
      path: `session:${parentSessionId}`,
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
  };
  applyDiscussionCatalogUpdate(fixture.models.discussionCatalog(parentSessionId), parentSessionId, {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId,
    threads: [thread],
  });
  const model = fixture.models.discussionConversation(
    sidecarSessionId,
    "/project",
    parentSessionId,
  );
  const snapshot: ConversationSnapshot = {
    sessionId: sidecarSessionId,
    sessionFile: paginated ? "/chat.sqlite" : "/sidecar.jsonl",
    parts: [recent],
    ...(paginated ? { historyCursor: cursor } : {}),
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: true,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  let revision = 0;
  const publish = (parts: UiPart[]) =>
    act(() =>
      applyConversationUpdate(model, {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: { ...snapshot, parts },
      }),
    );
  publish([recent]);
  chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  chat.sideChats.chatStore(thread.id)!.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  chat.openSideChat(thread.id);
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
      <Surface chat={chat} />
    </VirtuosoMockContext.Provider>,
  );
  return {
    panel: within(screen.getByRole("complementary", { name: "Side chat" })),
    abort,
    model,
    sidecarSessionId,
    publish,
    dispose() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

it.each(scopes)(
  "pages %s side-chat originals in order, retries and keeps loaded history through live rollover",
  async (_scope, parentSessionId) => {
    const history = vi
      .fn<Client["sessionChats"]["history"]>()
      .mockRejectedValueOnce(new Error("Read temporarily unavailable"))
      .mockResolvedValueOnce({ parts: [older, recent], cursor: olderCursor })
      .mockResolvedValueOnce({ parts: [oldest, older], cursor: undefined });
    using fixture = renderHistory(parentSessionId, history);
    const user = userEvent.setup();
    const panel = fixture.panel;
    await user.click(panel.getByRole("button", { name: "Load earlier messages" }));
    expect(await panel.findByText("Read temporarily unavailable")).toBeTruthy();
    await user.click(panel.getByRole("button", { name: "Load earlier messages" }));
    expect(await panel.findByText("Older side-chat original")).toBeTruthy();
    await user.click(panel.getByRole("button", { name: "Load earlier messages" }));
    expect(await panel.findByText("Oldest side-chat original")).toBeTruthy();
    expect(history.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: fixture.sidecarSessionId, cursor },
      { sessionId: fixture.sidecarSessionId, cursor },
      { sessionId: fixture.sidecarSessionId, cursor: olderCursor },
    ]);
    const messages = () =>
      panel
        .getAllByText(/(?:Oldest|Older|Recent|Live) side-chat original/)
        .map((node) => node.textContent);
    expect(messages()).toEqual([oldest.text, older.text, recent.text]);
    expect(panel.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
    fixture.publish([textPart("entry-221-text", "Live side-chat original")]);
    expect(messages()).toEqual([oldest.text, older.text, recent.text, "Live side-chat original"]);
    expect(panel.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  },
);

it.each(scopes)(
  "does not advertise paging for a non-paginated %s sidecar",
  (_scope, parentSessionId) => {
    const history = vi.fn<Client["sessionChats"]["history"]>();
    using fixture = renderHistory(parentSessionId, history, false);
    expect(fixture.panel.getByText("Recent side-chat original")).toBeTruthy();
    expect(fixture.panel.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
    expect(history).not.toHaveBeenCalled();
  },
);

it.each(scopes)(
  "closing/disposal of a %s side chat never stops model execution and disposal cancels the history read",
  async (_scope, parentSessionId) => {
    const pending = Promise.withResolvers<Awaited<ReturnType<Client["sessionChats"]["history"]>>>();
    const history = vi.fn<Client["sessionChats"]["history"]>(() => pending.promise);
    using fixture = renderHistory(parentSessionId, history);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load earlier messages" }));
    const signal = history.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Close Side chat" }));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    expect(fixture.abort).not.toHaveBeenCalled();
    fixture.dispose();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ parts: [older], cursor: undefined }));
    expect(fixture.model.earlierParts).toHaveLength(0);
    expect(fixture.abort).not.toHaveBeenCalled();
  },
);
