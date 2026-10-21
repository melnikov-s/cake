/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ScheduledMessage } from "../../../src/contracts/scheduled-messages/scheduled-message-data";
import type { Client } from "../../../src/renderer/client/Client";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyScheduledMessageUpdate } from "../../../src/renderer/reducers/ScheduledMessageReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const now = "2026-10-21T22:00:00.000Z";
const checkIn: ScheduledMessage = {
  id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
  targetSessionId: CAKE_CHAT_SESSION_ID,
  text: "Check the PR status and report progress.",
  sendAt: "2026-10-21T22:03:00.000Z",
  createdAt: now,
  createdBySessionId: CAKE_CHAT_SESSION_ID,
  repeatEverySeconds: 180,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows a Cake Chat's own recurring check-in in its pending list and cancels it", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  using fixture = createRendererStoreFixture({
    client: {
      artifacts: { effective: async () => [] },
      scheduledMessages: {
        cancel: vi.fn<Client["scheduledMessages"]["cancel"]>(async (id) => {
          applyScheduledMessageUpdate(catalog, {
            _tag: "Event",
            revision: 2,
            event: { _tag: "Removed", id },
          });
        }),
      },
    },
  });
  const catalog = fixture.models.scheduledMessageCatalog(CAKE_CHAT_SESSION_ID);
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  act(() => {
    fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(CAKE_CHAT_SESSION_ID);
    fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    applyConversationSnapshot(chat.model, {
      sessionId: CAKE_CHAT_SESSION_ID,
      sessionFile: "/cake-chat.sqlite",
      parts: [],
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
    applyScheduledMessageUpdate(catalog, { _tag: "Snapshot", revision: 1, messages: [checkIn] });
  });
  render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        <CakeChatSurface />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );

  // Nothing is steering or queued, so the scheduled group is expanded.
  const group = await screen.findByRole("group", { name: "Scheduled" });
  expect(within(group).getByRole("button", { name: /1 scheduled/ }).textContent).toBe(
    "1 scheduled·next in 3:00·1 repeating",
  );
  const [row] = within(group).getAllByRole("listitem");
  expect(row?.textContent).toBe("Check the PR status and report progress.every 3min 3:00");
  expect(row?.title).toBe(
    `Sends at ${new Date(checkIn.sendAt).toLocaleString()}, then every 3m until cancelled`,
  );
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(row?.textContent).toContain("in 2:00");

  await user.click(
    within(group).getByRole("button", {
      name: `Cancel scheduled message: ${checkIn.text}`,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("group", { name: "Scheduled" })).toBeNull());
  expect(fixture.client.scheduledMessages.cancel).toHaveBeenCalledWith(
    checkIn.id,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
