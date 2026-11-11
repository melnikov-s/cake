/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { Client } from "../../../src/renderer/client/Client";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { emptyProjectTodos } from "../../../src/contracts/projects/project-todos";
import { ChatTranscript } from "../../../src/renderer/components/chat-transcript";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { applyPartUpdate } from "../../../src/renderer/reducers/SessionPartReducer";
import { readDurableOriginalPage } from "../../../src/services/pi-durable/durable-chat-history";
import { TaskAttributionDoc } from "../../../src/services/pi-durable/durable-task-attribution";
import { durableAnswer, durableModels } from "../../fixtures/durable-chat";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const todoId = "00000000-0000-4000-8000-000000000011";
const task = {
  id: todoId,
  title: "Explore interchangeable agent backends",
  description: "",
  status: "",
  state: "open" as const,
  revision: 0,
  associations: [],
};
afterEach(cleanup);

it.each([false, true])(
  "Show more combines repeated user + answer sections across original pages with a recent match (%s)",
  async (recentMatch) => {
    const storage = new MemoryStorage();
    const harness = await Harness.open(
      storage,
      { models: durableModels().models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      await conversation.commit(async (tx) => {
        const append = async (text: string, taskTodoId: string | null, timestamp: number) => {
          const entry = await tx.appendEntry(UserEntry, conversation.id, {
            model: [{ role: "user", content: text, timestamp }],
          });
          (await tx.doc(TaskAttributionDoc, conversation.id)).inputs[String(entry.id)] = {
            pending: false,
            todoId: taskTodoId,
          };
          await tx.appendEntry(AssistantEntry, conversation.id, {
            model: [{ ...durableAnswer(text + " answer"), timestamp: timestamp + 1 }],
          });
        };
        await append("Original backend question", todoId, 10);
        for (let i = 0; i < 210; i += 1) {
          await append("Unrelated " + i, "00000000-0000-4000-8000-000000000012", 100 + i * 2);
          if (i === 109) await append("Middle backend follow-up", todoId, 100 + i * 2 + 1);
        }
        if (recentMatch) await append("Recent backend follow-up", todoId, 1000);
      }, BACKGROUND_CONTEXT);
      const read = (cursor?: string) =>
        conversation.commit(
          async (tx) =>
            readDurableOriginalPage(
              {
                entries: (query, limit, next) =>
                  tx.scanEntries({ ...query, conversationId: conversation.id }, limit, next),
              },
              cursor,
              undefined,
              undefined,
              undefined,
              (await tx.doc(TaskAttributionDoc, conversation.id)).inputs,
            ),
          BACKGROUND_CONTEXT,
        );
      const initial = await read();
      const gate = Promise.withResolvers<void>();
      const history = vi.fn<Client["sessionChats"]["history"]>(async ({ cursor }) => {
        await gate.promise;
        const page = await read(cursor);
        // Overlapping boundary records must not duplicate an already loaded message.
        return { ...page, parts: [...page.parts, initial.parts[0]!] };
      });
      using fixture = createRendererStoreFixture({ client: { sessionChats: { history } } });
      applySnapshot(fixture.models.cakeChatTodos, {
        todos: { ...emptyProjectTodos(), items: [task] },
      });
      const session = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
      session.model.historyCursor = initial.cursor;
      initial.parts.forEach((part) =>
        applyPartUpdate(session.model.parts, part, session.sessionId),
      );
      session.todos.open();
      const chat = session.conversationSessionStore.chatStore;
      const view = render(
        <StoreProvider store={fixture.root}>
          <ChatTranscript store={chat} behavior={{ todos: session.todos }} />
          <aside aria-label="To-do">
            <ProjectTodosPanel store={session.todos} />
          </aside>
        </StoreProvider>,
      );
      try {
        expect(history).not.toHaveBeenCalled();
        await userEvent.setup().click(
          within(screen.getByRole("complementary", { name: "To-do" })).getByRole("button", {
            name: task.title,
          }),
        );
        expect(history).not.toHaveBeenCalled();
        if (recentMatch) expect(chat.transcriptInteraction.selectedMessageId).not.toBeUndefined();
        expect(screen.queryByText("No messages tagged to this to-do.")).toBeNull();
        const u = userEvent.setup();
        await u.click(screen.getByRole("button", { name: "Show more" }));
        expect(history).toHaveBeenCalledOnce();
        expect(screen.getByRole("button", { name: "Show more" })).toHaveProperty("disabled", true);
        await act(async () => gate.resolve());
        expect(await screen.findByText("Middle backend follow-up answer")).toBeDefined();
        expect(screen.queryByText("Original backend question")).toBeNull();
        expect(history).toHaveBeenCalledOnce();
        expect(screen.queryByRole("button", { name: `Show in To-do: ${task.title}` })).toBeNull();
        expect(view.container.querySelector('[data-slot="task-section-disclosure"]')).toBeNull();
        await u.click(screen.getByRole("button", { name: "Show more" }));
        await waitFor(() => expect(chat.history?.hasMore).toBe(false));
        expect(history).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
        expect(await screen.findByText("Original backend question")).toBeDefined();
        expect(screen.getByText("Original backend question answer")).toBeDefined();
        expect(screen.queryByText("Unrelated 0 answer")).toBeNull();
        if (recentMatch) {
          expect(screen.getByText("Recent backend follow-up answer")).toBeDefined();
        }
        expect(session.model.uiParts.length).toBe(recentMatch ? 426 : 424);
        const messages = Array.from(
          view.container.querySelectorAll<HTMLElement>('[data-slot="transcript-item"]'),
        )
          .sort(
            (left, right) =>
              Number(left.dataset.transcriptItemIndex) - Number(right.dataset.transcriptItemIndex),
          )
          .map((row) => row.querySelector('[data-slot="message-content"]')?.textContent);
        expect(messages).toEqual([
          "Original backend question",
          "Original backend question answer",
          "Middle backend follow-up",
          "Middle backend follow-up answer",
          ...(recentMatch ? ["Recent backend follow-up", "Recent backend follow-up answer"] : []),
        ]);
        expect(screen.queryByRole("button", { name: `Show in To-do: ${task.title}` })).toBeNull();
      } finally {
        view.unmount();
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
);

it("retries Focus paging errors without falsely declaring empty history or continuing after clear", async () => {
  const nextPage = Promise.withResolvers<Awaited<ReturnType<Client["sessionChats"]["history"]>>>();
  const history = vi
    .fn<Client["sessionChats"]["history"]>()
    .mockRejectedValueOnce(new Error("Originals temporarily unavailable"))
    .mockImplementationOnce(() => nextPage.promise);
  using fixture = createRendererStoreFixture({ client: { sessionChats: { history } } });
  applySnapshot(fixture.models.cakeChatTodos, { todos: { ...emptyProjectTodos(), items: [task] } });
  const session = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  session.model.historyCursor = "first";
  session.todos.open();
  const view = render(
    <ChatTranscript
      store={session.conversationSessionStore.chatStore}
      behavior={{ todos: session.todos }}
    />,
  );
  try {
    act(() => session.todos.toggleFocus(task));
    await userEvent.setup().click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Originals temporarily unavailable")).toBeDefined();
    expect(screen.queryByText("No messages tagged to this to-do.")).toBeNull();
    expect(history).toHaveBeenCalledOnce();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry loading earlier messages" }));
    act(() => session.todos.clearFocus());
    await act(async () => nextPage.resolve({ parts: [], cursor: "second" }));
    expect(history).toHaveBeenCalledTimes(2);
    expect(session.conversationSessionStore.chatStore.history?.hasMore).toBe(true);
  } finally {
    view.unmount();
  }
});
