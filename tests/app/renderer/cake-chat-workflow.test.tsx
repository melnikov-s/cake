/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-data";
import { Chat } from "../../../src/renderer/components/chat";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { workerActivity, workerTranscript, handleId } from "./subagent-activity-workflow-fixture";
import type { Client } from "../../../src/renderer/client/Client";

const Surface = observer(function Surface({ root }: { root: RootStore }) {
  const chat = root.cakeChatCollectionStore.activeSession;
  return (
    <>
      <SidebarCakeChatGroup
        cakeChat={root.cakeChatCollectionStore}
        shell={root.appShellStore}
        onOpenCakeChat={(id) => void root.navigationStore.openCakeChat(id)}
      />
      {chat && (
        <SideChatLayout
          store={chat.conversationSessionStore.sideChatStore}
          renderChat={(store) => <Chat store={store} embedded composerFocusEnabled={false} />}
        >
          <Chat
            store={chat.conversationSessionStore.chatStore}
            transcriptBehavior={{ subagents: chat.subagentActivityStore }}
            embedded
            composerFocusEnabled={false}
          />
        </SideChatLayout>
      )}
    </>
  );
});

afterEach(cleanup);
it("reopening the permanent assistant retains its conversation and unsent message", async () => {
  using fixture = createRendererStoreFixture();
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const view = render(<Surface root={fixture.root} />);
  try {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.type(
      screen.getByRole("combobox", { name: "Message Cake Chat" }),
      "Discuss my projects",
    );
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toHaveProperty(
      "value",
      "Discuss my projects",
    );
    expect(fixture.root.cakeChatCollectionStore.sessionId).toBe(CAKE_CHAT_SESSION_ID);
  } finally {
    view.unmount();
  }
});

it("opens Cake Chat project investigators in the existing subagent interface and preserves follow-ups until release", async () => {
  const prompt = vi.fn<Client["subagents"]["prompt"]>(async () => undefined);
  using fixture = createRendererStoreFixture({ client: { subagents: { prompt } } });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const catalog = fixture.models.subagentCatalog(CAKE_CHAT_SESSION_ID);
  const activity = workerActivity({
    parentSessionId: CAKE_CHAT_SESSION_ID,
    projectPath: "/project",
    status: "complete",
    streaming: false,
    parts: [
      {
        id: "context",
        kind: "context",
        title: "System prompt",
        text: "Project investigation context",
      },
      {
        id: "answer",
        kind: "text",
        role: "assistant",
        status: "complete",
        text: "config.ts:12 explains this default.",
      },
    ],
  });
  act(() => {
    fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
    applyConversationSnapshot(chat.model, {
      sessionId: CAKE_CHAT_SESSION_ID,
      sessionFile: "/cake-chat.sqlite",
      parts: workerTranscript(),
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    });
    applySubagentUpdate(catalog, CAKE_CHAT_SESSION_ID, {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: CAKE_CHAT_SESSION_ID,
      activities: [activity],
      backgroundActive: false,
    });
    chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
    chat.subagentActivityStore.chatStores[0]?.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <Surface root={fixture.root} />
    </VirtuosoMockContext.Provider>,
  );
  try {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    const summary = (await screen.findByText("Work log")).closest("summary");
    if (!summary) throw new Error("Missing work log");
    await user.click(summary);
    await user.click(await screen.findByRole("button", { name: "Open subagent chat" }));
    const panel = screen.getByRole("complementary", { name: "Subagent" });
    expect(await within(panel).findByText("config.ts:12 explains this default.")).toBeDefined();
    await user.type(
      within(panel).getByRole("combobox", { name: "Message subagent" }),
      "Recheck that file",
    );
    await user.click(within(panel).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        { parentSessionId: CAKE_CHAT_SESSION_ID, handleId, text: "Recheck that file" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    act(() =>
      applySubagentUpdate(catalog, CAKE_CHAT_SESSION_ID, {
        _tag: "Removed",
        revision: 2,
        parentSessionId: CAKE_CHAT_SESSION_ID,
        handleId,
      }),
    );
    expect(await within(panel).findByText("Released")).toBeDefined();
    expect(within(panel).queryByRole("combobox", { name: "Message subagent" })).toBeNull();
  } finally {
    view.unmount();
  }
});
