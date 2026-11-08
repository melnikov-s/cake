/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer, StoreProvider } from "r-state-tree/react";
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
import { scrollTranscriptEarlier } from "./scroll-transcript-earlier";

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
    client: {
      cakeChats: { open: async () => undefined },
      sessionChats: { history, abort },
      discussionSessions: { setResolved: async () => ({ ...thread, status: "resolved" }) },
    },
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
  const publish = (parts: UiPart[], update: Partial<ConversationSnapshot> = {}) =>
    act(() =>
      applyConversationUpdate(model, {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: { ...snapshot, parts, ...update },
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
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        <Surface chat={chat} />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
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
  "shows %s side-chat active context/window, live changes, unavailable state and reopening",
  async (_scope, parentSessionId) => {
    using fixture = renderHistory(parentSessionId, async () => ({ parts: [] }));
    const user = userEvent.setup();
    const usage = (tokens: number | null, contextWindow: number) => ({
      tokens: { input: 500_000, output: 10_000, cacheRead: 0, cacheWrite: 0, total: 510_000 },
      cost: 1,
      context: {
        tokens,
        contextWindow,
        percent: tokens === null ? null : (tokens / contextWindow) * 100,
      },
    });
    const indicator = () => fixture.panel.getByRole("img", { name: "Context usage" });
    expect(indicator().textContent).toBe("Context unavailable");
    fixture.publish([recent], { usage: usage(28_200, 300_000) });
    expect(indicator().textContent).toContain("≈28.2k/300k");
    expect(within(indicator()).getByText("9%")).toBeDefined();
    expect(indicator().getAttribute("aria-description")).toContain("28,200 of 300,000");
    expect(indicator().querySelector("svg")).toBeTruthy();
    // The parent retains its existing inspectable main-chat control.
    expect(screen.getByRole("button", { name: "Browse context" })).toBeTruthy();
    fixture.publish([recent], { usage: usage(31_000, 64_000) });
    expect(indicator().textContent).toContain("≈31k/64k");
    expect(within(indicator()).getByText("48%")).toBeDefined();
    fixture.publish([recent], { usage: usage(null, 64_000) });
    expect(indicator().textContent).toBe("Context unavailable");
    fixture.publish([recent], { usage: usage(32_000, 64_000) });
    await user.click(screen.getByRole("button", { name: "Close and resolve" }));
    await user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    const menu = within(screen.getByRole("dialog", { name: "Open side chats" }));
    expect(menu.getByText("Working…")).toBeTruthy();
    await user.click(menu.getByRole("button", { name: "Side chat" }));
    const reopened = within(screen.getByRole("complementary", { name: "Side chat" }));
    expect(reopened.getByRole("img", { name: "Context usage" }).textContent).toContain("≈32k/64k");
    expect(reopened.getByText("50%")).toBeDefined();
  },
);

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
    expect(history).not.toHaveBeenCalled();
    scrollTranscriptEarlier(panel.getByText("Earlier messages"));
    expect(await panel.findByText("Read temporarily unavailable")).toBeTruthy();
    scrollTranscriptEarlier(panel.getByText("Earlier messages"));
    expect(history).toHaveBeenCalledTimes(1);
    await user.click(panel.getByRole("button", { name: "Retry loading earlier messages" }));
    expect(await panel.findByText("Older side-chat original")).toBeTruthy();
    scrollTranscriptEarlier(panel.getByText("Earlier messages"));
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
    scrollTranscriptEarlier(fixture.panel.getByText("Earlier messages"));
    const signal = history.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Close and resolve" }));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    expect(fixture.abort).not.toHaveBeenCalled();
    fixture.dispose();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ parts: [older], cursor: undefined }));
    expect(fixture.model.earlierParts).toHaveLength(0);
    expect(fixture.abort).not.toHaveBeenCalled();
  },
);
