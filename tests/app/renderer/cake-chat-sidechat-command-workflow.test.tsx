/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
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
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderChat(
  sessionId: string,
  options: { pending?: boolean; empty?: boolean; fail?: boolean } = {},
) {
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
  const start = vi.fn<Client["cakeChats"]["start"]>();
  const thread: DiscussionThread = {
    id: "new-thread",
    workingDirectory: "/project",
    parentSessionId: sessionId,
    sidecarSessionId: "sidecar-1",
    anchor: {
      path: `session:${sessionId}/message/assistant-1`,
      view: "message",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: "",
      contextBefore: "",
      contextAfter: "",
      diff: "",
      startOffset: 0,
      endOffset: 0,
      messageId: "assistant-1",
      entryId: "entry-1",
    },
    parts: [],
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const startSideChat = vi.fn<Client["cakeChats"]["startSideChat"]>(async () => {
    if (options.fail) throw new Error("Side chat service unavailable");
    return { thread, turnId: TurnId.make("10000000-0000-4000-8000-000000000001") };
  });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      artifacts: { effective: async () => [] },
      sessionChats: { prompt },
      cakeChats: { start, startSideChat },
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
  applyConversationSnapshot(chat.model, snapshot);
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        <CakeChatSurface />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    prompt,
    start,
    startSideChat,
    thread,
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
          parts: [],
          commands: [],
        },
      );
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
  it("discovers the command and opens the existing draft, anchored to the latest completed reply while streaming", async () => {
    using fixture = renderChat(sessionId);
    const main = screen.getByRole<HTMLTextAreaElement>("combobox");
    await fixture.user.type(main, "/side");
    expect(
      await screen.findByRole("option", { name: /sidechat \[prompt\] Start a side chat/ }),
    ).toBeDefined();
    await fixture.user.keyboard("{Enter}");
    const panel = await screen.findByRole("complementary", { name: "Side chat" });
    expect(main.value).toBe("");
    expect(fixture.startSideChat).not.toHaveBeenCalled();
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
      await within(panel).findByRole("combobox", { name: "Reply to selection side chat" }),
    ).toBeDefined();
    await fixture.user.click(within(panel).getByRole("button", { name: "Close Side chat" }));
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
