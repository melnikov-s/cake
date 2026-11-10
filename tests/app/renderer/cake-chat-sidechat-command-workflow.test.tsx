/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { cakeChatBuiltinSlashCommands } from "../../../src/contracts/conversations/session-contract";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { Client } from "../../../src/renderer/client/Client";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderChat(
  sessionId: string,
  options: {
    pending?: boolean;
    empty?: boolean;
    fail?: boolean;
    originalHistory?: boolean;
    queued?: boolean;
  } = {},
) {
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000002"),
  );
  const start = vi.fn<Client["cakeChats"]["start"]>();
  const thread: DiscussionThread = {
    id: "new-thread",
    workingDirectory: "/project",
    parentSessionId: sessionId,
    sidecarSessionId: "sidecar-1",
    anchor: {
      path: `session:${sessionId}`,
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
  const handoff = Promise.withResolvers<void>();
  const startSideChat = vi.fn<Client["cakeChats"]["startSideChat"]>(async () => {
    if (options.fail) throw new Error("Side chat service unavailable");
    if (options.queued) await handoff.promise;
    return { thread, turnId: TurnId.make("10000000-0000-4000-8000-000000000001") };
  });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      artifacts: { effective: async () => [] },
      sessionChats: { prompt },
      cakeChats: { start, startSideChat },
      discussionSessions: { setResolved: async () => ({ ...thread, status: "resolved" }) },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: options.pending
      ? []
      : [
          {
            sessionId,
            title: "Chat",
            ...(sessionId === CAKE_CHAT_SESSION_ID ? {} : { projectPath: "/project" }),
          },
        ],
  });
  const collection = fixture.root.cakeChatCollectionStore;
  const chat = collection.registry.load(sessionId);
  if (options.pending) collection.pendingSessions.create(sessionId);
  collection.sessionLayoutStore.showSession(sessionId);
  fixture.root.navigationStore.selectCakeChat(sessionId);
  const queuedPart = {
    id: "queued-waiting",
    kind: "text",
    role: "user",
    text: "Waiting question",
    status: "complete",
    deliveryState: "queued",
    queuedInput: {
      itemId: "10000000-0000-4000-8000-000000000003",
      turnId: "10000000-0000-4000-8000-000000000003",
      text: "Waiting question",
      renderUserMessageAsMarkdown: true,
      attachments: [{ kind: "text", name: "Notes", text: "Keep context" }],
    },
  };
  const snapshot: ConversationSnapshot = {
    sessionId,
    sessionFile: options.pending ? "" : "/chat.sqlite",
    parts: options.empty
      ? []
      : [
          {
            id: "assistant-1",
            entryId: "entry-1",
            kind: "text",
            role: "assistant",
            text: "Completed reply",
            status: "complete",
          },
          {
            id: "assistant-2",
            entryId: "entry-2",
            kind: "text",
            role: "assistant",
            text: "Working now",
            status: "streaming",
          },
          ...(options.queued ? [queuedPart] : []),
        ],
    models: [],
    model: { provider: "anthropic", id: "claude", name: "Claude" },
    thinkingLevel: "high",
    availableThinkingLevels: ["off", "high"],
    streaming: !options.empty,
    diagnostics: [],
    commands: cakeChatBuiltinSlashCommands,
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  applyConversationUpdate(chat.model, { _tag: "Snapshot", revision: 1, snapshot });
  chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <>
        <CakeChatSurface />
      </>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    prompt,
    start,
    startSideChat,
    thread,
    handoff,
    chat,
    queueSide() {
      applyConversationSnapshot(
        fixture.models.discussionConversation("sidecar-1", "/project", sessionId),
        {
          ...snapshot,
          sessionId: "sidecar-1",
          streaming: true,
          parts: [queuedPart],
        },
      );
    },
    removeQueued() {
      applyConversationUpdate(chat.model, {
        _tag: "Snapshot",
        revision: 2,
        snapshot: {
          ...snapshot,
          parts: snapshot.parts.slice(0, -1),
        },
      });
    },
    publish() {
      applyDiscussionCatalogUpdate(fixture.models.discussionCatalog(sessionId), sessionId, {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: sessionId,
        threads: [thread],
      });
      applyConversationSnapshot(
        fixture.models.discussionConversation("sidecar-1", "/project", sessionId),
        {
          ...snapshot,
          sessionId: "sidecar-1",
          streaming: false,
          parts: options.originalHistory
            ? [
                {
                  id: "inherited-question",
                  entryId: "old-1",
                  kind: "text",
                  role: "user",
                  text: "The main question",
                  status: "complete",
                  originalHistory: true,
                },
                {
                  id: "inherited-answer",
                  entryId: "old-2",
                  kind: "text",
                  role: "assistant",
                  text: "The main answer",
                  status: "complete",
                  originalHistory: true,
                },
                {
                  id: "side-question",
                  entryId: "new-1",
                  kind: "text",
                  role: "user",
                  text: "A separate question",
                  status: "complete",
                },
              ]
            : [],
          commands: [],
        },
      );
      chat.sideChats
        .chatStore(thread.id)
        ?.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe.each([
  ["Cake Chat", CAKE_CHAT_SESSION_ID],
  ["Project Chat", `project-chat:${"a".repeat(64)}`],
])("%s /sidechat", (_name, sessionId) => {
  it("keeps ordinary Send in the busy conversation instead of automatically forwarding", async () => {
    using fixture = renderChat(sessionId);
    await fixture.user.type(screen.getByRole("combobox"), "Keep this here");
    expect(screen.queryByRole("button", { name: "Send to side chat" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.prompt).toHaveBeenCalledTimes(1));
    expect(fixture.prompt.mock.calls[0]![0]).toMatchObject({ sessionId, text: "Keep this here" });
    expect(fixture.startSideChat).not.toHaveBeenCalled();
  });
  it("sends only the selected admitted queue ID, keeps the draft, and opens the resulting side chat", async () => {
    using fixture = renderChat(sessionId, { originalHistory: true, queued: true });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox");
    await fixture.user.type(input, "Keep my draft");
    expect(screen.queryByRole("button", { name: "Send to side chat" })).toBeNull();
    const send = screen.getByRole<HTMLButtonElement>("button", {
      name: "Send to side chat: Waiting question",
    });
    await fixture.user.click(send);
    expect(send.disabled).toBe(true);
    await fixture.user.click(send);
    expect(fixture.startSideChat).toHaveBeenCalledTimes(1);
    expect(fixture.startSideChat.mock.calls[0]![0]).toMatchObject({
      parentSessionId: sessionId,
      queuedPartId: "queued-waiting",
      anchor: { view: "session" },
      text: "",
    });
    expect(input.value).toBe("Keep my draft");
    expect(
      screen.getByRole("button", { name: "Send to side chat: Waiting question" }),
    ).toBeDefined();
    await act(async () => {
      fixture.handoff.resolve();
    });
    act(() => {
      fixture.removeQueued();
      fixture.publish();
    });
    expect(
      screen.queryByRole("button", { name: "Send to side chat: Waiting question" }),
    ).toBeNull();
    const panel = await screen.findByRole("complementary", { name: "Side chat" });
    const history = await within(panel).findByRole("button", { name: "Original history" });
    expect(within(panel).queryByText("The main question")).toBeNull();
    expect(within(panel).getByText("A separate question")).toBeDefined();
    await fixture.user.click(history);
    expect(within(panel).getByText("The main question")).toBeDefined();
    expect(within(panel).getByText("The main answer")).toBeDefined();
    const sideInput = within(panel).getByRole("combobox");
    await fixture.user.type(sideInput, "Another separate question");
    expect(within(panel).queryByRole("button", { name: "Send to side chat" })).toBeNull();
    act(() => fixture.queueSide());
    await fixture.user.click(
      within(panel).getByRole("button", { name: "Send to side chat: Waiting question" }),
    );
    expect(fixture.startSideChat).toHaveBeenCalledTimes(2);
    expect(fixture.startSideChat.mock.calls[1]![0]).toMatchObject({
      parentSessionId: "sidecar-1",
      queuedPartId: "queued-waiting",
      text: "",
    });
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("retains the queued item and unrelated draft on failure, with a retryable error", async () => {
    using fixture = renderChat(sessionId, { fail: true, queued: true });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox");
    await fixture.user.click(input);
    await fixture.user.paste("attachment line\n".repeat(100));
    await fixture.user.type(input, "Keep my draft");
    await fixture.user.click(
      screen.getByRole("button", { name: "Send to side chat: Waiting question" }),
    );
    expect(await screen.findByText("Side chat service unavailable")).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Send to side chat: Waiting question" })
        .disabled,
    ).toBe(false);
    expect(input.value).toBe("Keep my draft");
    expect(screen.getByRole("button", { name: /Remove.*Pasted text/ })).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false);
    expect(fixture.prompt).not.toHaveBeenCalled();
  });
  it("opens a session-level draft without inventing a source selection while streaming", async () => {
    using fixture = renderChat(sessionId, { originalHistory: true });
    const main = screen.getByRole<HTMLTextAreaElement>("combobox");
    await fixture.user.type(main, "/side");
    expect(
      await screen.findByRole("option", { name: /sidechat \[prompt\] Start a side chat/ }),
    ).toBeDefined();
    await fixture.user.keyboard("{Enter}");
    const panel = await screen.findByRole("complementary", { name: "Side chat" });
    expect(main.value).toBe("");
    expect(fixture.startSideChat).not.toHaveBeenCalled();
    expect(fixture.chat.messageCommentsStore.draftSelection).toBeUndefined();
    expect(fixture.chat.messageCommentsStore.draftChatStore.parts).toEqual([]);
    expect(within(panel).queryByText("Completed reply")).toBeNull();
    expect(await screen.findByText("Completed reply")).toBeDefined();
    await fixture.user.type(within(panel).getByRole("combobox"), "Explain that reply");
    await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fixture.startSideChat).toHaveBeenCalledTimes(1));
    expect(fixture.startSideChat.mock.calls[0]![0]).toEqual({
      parentSessionId: sessionId,
      text: "Explain that reply",
      anchor: fixture.thread.anchor,
      annotations: [],
      model: { provider: "anthropic", id: "claude" },
      thinkingLevel: "high",
    });
    // Catalog delivery switches the existing draft panel to the real side-chat conversation.
    act(() => fixture.publish());
    expect(
      await within(panel).findByRole("combobox", { name: "Reply to side chat" }),
    ).toBeDefined();
    expect(
      fixture.chat.sideChats.chatStore(fixture.thread.id)?.parts.map((part) => part.id),
    ).toEqual(["inherited-question", "inherited-answer", "side-question"]);
    expect(within(panel).queryByText("Completed reply")).toBeNull();
    expect(within(panel).getByText("A separate question")).toBeDefined();
    await fixture.user.click(within(panel).getByRole("button", { name: "Original history" }));
    expect(within(panel).getByText("The main answer")).toBeDefined();
    await fixture.user.click(within(panel).getByRole("button", { name: "Close and resolve" }));
    expect(screen.getByRole("combobox")).toBe(main);
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("sends an optional trailing prompt to the existing side-chat service, not the parent", async () => {
    using fixture = renderChat(sessionId);
    await fixture.user.type(screen.getByRole("combobox"), "/sidechat Explain that reply");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(fixture.startSideChat).toHaveBeenCalledTimes(1);
    expect(fixture.startSideChat.mock.calls[0]![0]).toMatchObject({
      text: "Explain that reply",
      anchor: fixture.thread.anchor,
    });
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("");
    act(() => fixture.publish());
    const panel = await screen.findByRole("complementary", { name: "Side chat" });
    expect(within(panel).queryByText("Completed reply")).toBeNull();
    expect(fixture.chat.sideChats.chatStore(fixture.thread.id)?.parts).toEqual([]);
    expect(within(panel).getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
    expect(await screen.findByText("Completed reply")).toBeDefined();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("keeps attachments in the parent draft rather than silently dropping them", async () => {
    using fixture = renderChat(sessionId);
    const input = screen.getByRole("combobox");
    await fixture.user.click(input);
    await fixture.user.paste("attachment line\n".repeat(100));
    await fixture.user.type(input, "/sidechat");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Remove attachments before using /sidechat")).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("/sidechat");
    expect(screen.getByRole("button", { name: /Remove.*Pasted text/ })).toBeDefined();
    expect(fixture.startSideChat).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it.each([
    [{ empty: true }, "/sidechat", "Side chats require a completed assistant response"],
    [{ pending: true }, "/sidechat", "Side chats require an existing conversation"],
    [{ fail: true }, "/sidechat Explain", "Side chat service unavailable"],
  ])("retains unsupported or failed commands (%j)", async (options, command, error) => {
    using fixture = renderChat(sessionId, options);
    await fixture.user.type(screen.getByRole("combobox"), command);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(error)).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe(command);
    expect(fixture.startSideChat).toHaveBeenCalledTimes("fail" in options ? 1 : 0);
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });
});
