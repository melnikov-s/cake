/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const assistantText = "Ship the release after the database migration finishes.";
const parts: UiPart[] = [
  {
    id: "entry-7-text-0",
    kind: "text",
    role: "assistant",
    entryId: "7",
    text: assistantText,
    status: "complete",
  },
];

const snapshot = {
  sessionId: CAKE_CHAT_SESSION_ID,
  sessionFile: "/cake-chat.sqlite",
  parts,
  models: [],
  thinkingLevel: "off" as const,
  availableThinkingLevels: ["off" as const],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
};

beforeEach(() => {
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

it("adds a selected Cake Chat passage as a composer annotation sent with the next message", async () => {
  const user = userEvent.setup();
  const showTranscriptSelectionContextMenu = vi.fn<
    Client["electron"]["showTranscriptSelectionContextMenu"]
  >(async () => "add-annotation");
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000001"),
  );
  using fixture = createRendererStoreFixture({
    client: {
      electron: { showTranscriptSelectionContextMenu },
      sessionChats: { prompt },
      artifacts: { effective: async () => [] },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  act(() => {
    fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(CAKE_CHAT_SESSION_ID);
    fixture.root.appShellStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    applyConversationSnapshot(chat.model, snapshot);
    chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        <CakeChatSurface />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );

  const content = await waitFor(() => {
    const element = view.container.querySelector<HTMLElement>(
      '[data-part-id="entry-7-text-0"] [data-slot="message-content"]',
    );
    expect(element).not.toBeNull();
    return element!;
  });
  const textNode = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode()!;
  const start = assistantText.indexOf("database migration");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + "database migration".length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    content.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  // Cake Chat offers both selection workflows: side chat and annotation.
  expect(showTranscriptSelectionContextMenu).toHaveBeenCalledWith(
    { canChat: true, canAnnotate: true },
    expect.anything(),
  );

  await user.type(
    await screen.findByRole("textbox", { name: "Annotation comment" }),
    "Confirm the window with ops{Enter}",
  );
  const composerAnnotations = chat.conversationSessionStore.chatStore.annotations;
  expect(composerAnnotations).toEqual([
    expect.objectContaining({
      messageId: "entry-7-text-0",
      entryId: "7",
      selectedText: "database migration",
      comment: "Confirm the window with ops",
    }),
  ]);

  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            kind: "annotation",
            annotations: [expect.objectContaining({ selectedText: "database migration" })],
          },
        ],
      }),
      expect.anything(),
    ),
  );
  // The composer is cleared once the annotation is consumed by the sent message.
  expect(chat.conversationSessionStore.chatStore.annotations).toEqual([]);

  // Cake Chat's canonical entry carries the same annotation part as a Project
  // Session, so it renders the shared AnnotationSummary and the optimistic copy
  // reconciles instead of staying pinned above the composer.
  const sent = prompt.mock.calls[0]![0].attachments![0] as Extract<
    NonNullable<Parameters<Client["sessionChats"]["prompt"]>[0]["attachments"]>[number],
    { kind: "annotation" }
  >;
  expect(screen.getAllByRole("button", { name: "View 1 annotation" })).toHaveLength(1);
  act(() =>
    applyConversationSnapshot(chat.model, {
      ...snapshot,
      parts: [
        ...parts,
        { id: "entry-8-annotation-0", kind: "annotation", annotations: sent.annotations },
      ],
    }),
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-part-id^="optimistic-user-"]')).toBeNull(),
  );
  expect(screen.getAllByRole("button", { name: "View 1 annotation" })).toHaveLength(1);
  expect(screen.queryByRole("link", { name: "Annotations" })).toBeNull();
});
