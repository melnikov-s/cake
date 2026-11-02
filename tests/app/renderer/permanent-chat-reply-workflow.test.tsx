/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const question: Extract<UiPart, { kind: "text" }> = {
  kind: "text",
  id: "question",
  entryId: "question-entry",
  role: "user",
  text: "Original question",
  status: "complete",
};
const answer: Extract<UiPart, { kind: "text" }> = {
  ...question,
  id: "answer",
  entryId: "answer-entry",
  role: "assistant",
  text: "Original answer",
};
const utilities: UiPart[] = [
  { kind: "context", id: "context", title: "Context", text: "Injected context" },
  { kind: "reasoning", id: "reasoning", text: "Thinking", status: "complete" },
];

afterEach(cleanup);

it.each([
  ["Cake Chat", CAKE_CHAT_SESSION_ID],
  ["Project Chat", `project-chat:${"a".repeat(64)}`],
])("limits replies to older agent messages in %s", (_, sessionId) => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      artifacts: { effective: async () => [] },
      cakeChats: { open: async () => undefined },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId,
        title: "Chat",
        ...(sessionId === CAKE_CHAT_SESSION_ID ? {} : { projectPath: "/project" }),
      },
    ],
  });
  const collection = fixture.root.cakeChatCollectionStore;
  const chat = collection.registry.load(sessionId);
  collection.pendingSessions.markMaterialized(sessionId);
  collection.sessionLayoutStore.showSession(sessionId);
  fixture.root.navigationStore.selectCakeChat(sessionId);
  const publish = (parts: UiPart[], streaming = false) =>
    act(() => {
      applyConversationSnapshot(chat.model, {
        sessionId,
        sessionFile: "/chat.sqlite",
        parts,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      });
    });
  publish([question]);
  chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        <CakeChatSurface />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  const expectReplies = (ids: string[]) =>
    expect(
      screen
        .queryAllByRole("button", { name: "Reply to message" })
        .map((button) => button.closest("[data-part-id]")?.getAttribute("data-part-id")),
    ).toEqual(ids);
  try {
    expectReplies([]);
    publish([question, answer, ...utilities]);
    expectReplies([]);

    const nextQuestion = { ...question, id: "next-question", entryId: "next-question-entry" };
    publish([question, answer, nextQuestion, ...utilities]);
    expectReplies(["answer"]);

    // An empty assistant placeholder is not a visible conversational message.
    const live = {
      ...answer,
      id: "live",
      entryId: undefined,
      renderKey: "live-answer",
      status: "streaming" as const,
      text: "",
    };
    publish([question, answer, nextQuestion, live, ...utilities], true);
    expectReplies(["answer"]);
    // Once visible, the unaddressable stream becomes newest, not the last
    // reply-eligible message. Earlier actions must remain available.
    publish(
      [question, answer, nextQuestion, { ...live, text: "Arriving answer" }, ...utilities],
      true,
    );
    expectReplies(["answer"]);
    publish([
      question,
      answer,
      nextQuestion,
      {
        ...live,
        id: "settled",
        entryId: "settled-entry",
        text: "Arriving answer",
        status: "complete",
      },
      ...utilities,
    ]);
    expectReplies(["answer"]);

    // A newly arriving user message (including its pending draft projection)
    // takes the newest slot without gaining a redundant reply action.
    const draft = { ...question, id: "draft", entryId: undefined, draft: true };
    const settled = { ...answer, id: "settled", entryId: "settled-entry" };
    publish([question, answer, nextQuestion, settled, draft, ...utilities]);
    expectReplies(["answer", "settled"]);
    publish([question, answer, nextQuestion, settled, { ...draft, draft: false, entryId: "sent" }]);
    expectReplies(["answer", "settled"]);
  } finally {
    view.unmount();
  }
});
