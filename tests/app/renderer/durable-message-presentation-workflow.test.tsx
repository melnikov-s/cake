/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectChatId = `project-chat:${"a".repeat(64)}`;
afterEach(cleanup);

it.each([CAKE_CHAT_SESSION_ID, projectChatId, "project-session"])(
  "offers saved display controls while editing follows the backend's actual capability (%s)",
  async (sessionId) => {
    const save = vi.fn(async () => undefined);
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "project-session", projectPath: "/project" })],
      client: { sessionChats: { setUserMessageMarkdown: save } },
    });
    const durable = sessionId !== "project-session";
    const owner = durable
      ? fixture.root.cakeChatCollectionStore.registry.load(sessionId)
      : fixture.root.sessionRegistry.load(sessionId, "/project");
    if (durable) fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(sessionId);
    let snapshot: ConversationSnapshot = {
      sessionId,
      workspacePath: "/project",
      sessionFile: durable ? "/chat.sqlite" : "/project/session.jsonl",
      parts: [
        {
          id: "user-original",
          entryId: "5",
          kind: "text",
          role: "user",
          text: "# Saved heading",
          status: "complete",
        },
      ],
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
    act(() => {
      applyConversationSnapshot(owner.model, snapshot);
      owner.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
        kind: "top",
      });
    });
    const view = render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
        <Chat
          store={owner.conversationSessionStore.chatStore}
          compact
          composerFocusEnabled={false}
        />
      </VirtuosoMockContext.Provider>,
    );
    const user = userEvent.setup();
    expect(Boolean(screen.queryByRole("button", { name: "Edit latest prompt" }))).toBe(!durable);
    await user.click(screen.getByRole("button", { name: "Render as Markdown" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "Saved heading" })).toBeDefined();
    act(() => {
      snapshot = {
        ...snapshot,
        parts: snapshot.parts.map((part) =>
          part.kind === "text" ? { ...part, renderAs: "markdown" } : part,
        ),
      };
      applyConversationSnapshot(owner.model, snapshot);
    });
    await user.click(screen.getByRole("button", { name: "Render as plain text" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(
      { sessionId, entryId: "5", renderAsMarkdown: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText("# Saved heading")).toBeDefined();
    if (!durable) {
      await user.click(screen.getByRole("button", { name: "Edit latest prompt" }));
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
        "value",
        "# Saved heading",
      );
    }
    view.unmount();
  },
);
