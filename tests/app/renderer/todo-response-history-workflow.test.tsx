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
  "retrieves earlier user + answer through multiple original pages even with a recent match (%s)",
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
        for (let i = 0; i < 210; i += 1) await append("Unrelated " + i, null, 100 + i * 2);
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
        return read(cursor);
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
        expect(history).toHaveBeenCalledOnce();
        expect(screen.queryByText("No messages tagged to this to-do.")).toBeNull();
        await act(async () => gate.resolve());
        await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(chat.history?.hasMore).toBe(false));
        expect(await screen.findByText("Original backend question")).toBeDefined();
        expect(screen.getByText("Original backend question answer")).toBeDefined();
        expect(screen.queryByText("Unrelated 0 answer")).toBeNull();
        if (recentMatch) {
          expect(screen.getByText("Recent backend follow-up answer")).toBeDefined();
          expect(chat.transcriptInteraction.selectedMessageId).not.toBeUndefined();
        }
        expect(session.model.uiParts.length).toBe(recentMatch ? 424 : 422);
      } finally {
        view.unmount();
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
);

it("stops Focus paging on errors or clear and retries without falsely declaring empty history", async () => {
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
