/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);
it("loads older originals through the shared Chat, retries failure, and retains them through live snapshots", async () => {
  const older = {
    id: "entry-1-text",
    kind: "text" as const,
    role: "user" as const,
    text: "Ancient original",
    status: "complete" as const,
  };
  const recent = { ...older, id: "entry-220-text", text: "Recent original" };
  const cursor = JSON.stringify({ olderThan: 220 });
  const history = vi
    .fn<Client["sessionChats"]["history"]>()
    .mockRejectedValueOnce(new Error("Read temporarily unavailable"))
    .mockResolvedValueOnce({ parts: [older], cursor: undefined });
  using fixture = createRendererStoreFixture({ client: { sessionChats: { history } } });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  await fixture.root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID);
  const session = fixture.root.cakeChatCollectionStore.activeSession!;
  const model = session.model;
  const snapshot: ConversationSnapshot = {
    sessionId: CAKE_CHAT_SESSION_ID,
    sessionFile: "/cake/pi/global-chat/coordinator.sqlite",
    parts: [recent],
    historyCursor: cursor,
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  applyConversationUpdate(model, { _tag: "Snapshot", revision: 1, snapshot });
  const view = render(
    <Chat
      store={session.conversationSessionStore.chatStore}
      embedded
      composerFocusEnabled={false}
    />,
  );
  try {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByText("Read temporarily unavailable")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(history).toHaveBeenLastCalledWith(
      { sessionId: CAKE_CHAT_SESSION_ID, cursor },
      { signal: expect.any(AbortSignal) },
    );
    expect(model.uiParts.map((part) => part.id)).toEqual([older.id, recent.id]);
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
    await act(async () =>
      applyConversationUpdate(model, {
        _tag: "Snapshot",
        revision: 2,
        snapshot: {
          ...snapshot,
          parts: [
            recent,
            { ...recent, id: "entry-221-text", role: "assistant", text: "New reply" },
          ],
        },
      }),
    );
    expect(model.uiParts.map((part) => part.id)).toEqual([older.id, recent.id, "entry-221-text"]);
    fixture.root[Symbol.dispose]();
    expect(model.earlierParts).toHaveLength(0);
  } finally {
    view.unmount();
  }
});
