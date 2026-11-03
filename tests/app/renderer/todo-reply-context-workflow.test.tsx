/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { Chat } from "../../../src/renderer/components/chat";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { ProjectTodoSelectionBar } from "../../../src/renderer/components/project-todo-selection-bar";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";

const task = (id: string, title: string): ProjectTodo => ({
  id,
  title,
  description: `${title} original description`,
  status: "",
  state: "open",
  revision: 0,
  associations: [],
});

it.each([CAKE_CHAT_SESSION_ID, `project-chat:${"a".repeat(64)}`])(
  "keeps focus independent from reply attachments, cancels them, and snapshots queued context in %s",
  async (sessionId) => {
    const a = task("00000000-0000-4000-8000-000000000011", "Task A");
    const b = task("00000000-0000-4000-8000-000000000012", "Task B");
    const originalDescription = b.description;
    const admitted = Promise.withResolvers<TurnId>();
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(() => admitted.promise);
    let todos = { ...emptyProjectTodos(), items: [a, b] };
    const project = () => ({ ...projectRecord({ path: "/project" }), todos });
    using f = createRendererStoreFixture({
      projects: [project()],
      client: {
        sessionChats: { prompt },
        cakeChats: { open: async () => undefined },
        projectTodos: {
          mutateUser: async ({ mutation }) => {
            if (mutation._tag !== "Select") throw new Error("Unexpected mutation");
            todos = { ...todos, selectedId: mutation.selectedId };
            publishTodos();
            return todos;
          },
        },
      },
    });
    function publishTodos() {
      if (sessionId === CAKE_CHAT_SESSION_ID) applySnapshot(f.models.cakeChatTodos, { todos });
      else applySnapshot(f.models.projects, { projects: [project()] });
    }
    publishTodos();
    const collection = f.root.cakeChatCollectionStore;
    applySnapshot(f.models.cakeChatCatalog, {
      loaded: true,
      sessions: [
        {
          sessionId,
          title: "Chat",
          ...(sessionId === CAKE_CHAT_SESSION_ID ? {} : { projectPath: "/project" }),
        },
      ],
    });
    const owner = collection.registry.load(sessionId);
    collection.pendingSessions.markMaterialized(sessionId);
    applyConversationUpdate(owner.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId,
        sessionFile: "/chat.sqlite",
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: true,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
        parts: [
          {
            kind: "text",
            id: "old",
            entryId: "old-entry",
            role: "assistant",
            text: "Older answer",
            status: "complete",
          },
          {
            kind: "text",
            id: "new",
            entryId: "new-entry",
            role: "user",
            text: "New question",
            status: "complete",
          },
        ],
      },
    });
    owner.todos.open();
    const chat = owner.conversationSessionStore.chatStore;
    chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    const view = render(
      <StoreProvider store={f.root}>
        <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
          <ProjectTodoSelectionBar todos={owner.todos} />
          <Chat
            store={chat}
            embedded
            composerFocusEnabled={false}
            transcriptBehavior={{ todos: owner.todos, canReplyToMessage: true }}
          />
          <aside aria-label="To-do">
            <ProjectTodosPanel store={owner.todos} />
          </aside>
        </VirtuosoMockContext.Provider>
      </StoreProvider>,
    );
    try {
      const user = userEvent.setup();
      const panel = within(screen.getByRole("complementary", { name: "To-do" }));
      const focusA = () => panel.getByRole("button", { name: "Task A" });
      await user.click(focusA());
      expect(focusA().getAttribute("aria-pressed")).toBe("true");
      await user.click(panel.getByRole("button", { name: "Attach to-do as context: Task B" }));
      expect(focusA().getAttribute("aria-pressed")).toBe("true");
      expect(panel.getByRole("button", { name: "Task B" }).getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(panel.getByRole("button", { name: "Mark done: Task B" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Remove To-do · Task B" })).toBeDefined();
      await user.click(screen.getByRole("button", { name: "Clear to-do focus" }));
      expect(screen.getByRole("button", { name: "Remove To-do · Task B" })).toBeDefined();
      await user.click(focusA());
      await user.click(screen.getByRole("button", { name: "Remove To-do · Task B" }));
      expect(focusA().getAttribute("aria-pressed")).toBe("true");

      // Message replies use exactly the same existing attachment preview/remove/send path.
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "Keep my draft" } });
      await user.click(screen.getByRole("button", { name: "Reply to message" }));
      expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe("Keep my draft");
      expect(screen.getByRole("button", { name: "Remove Reply to message" })).toBeDefined();
      await user.click(screen.getByRole("button", { name: "Remove Reply to message" }));
      await user.click(panel.getByRole("button", { name: "Attach to-do as context: Task B" }));
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(prompt).toHaveBeenCalledTimes(1);
      const submitted = prompt.mock.calls[0]![0];
      expect(submitted.text).toBe("Keep my draft");
      expect(submitted.attachments).toEqual([
        {
          kind: "text",
          name: "To-do · Task B",
          text: expect.stringContaining(originalDescription),
        },
      ]);
      expect(screen.queryByRole("button", { name: "Remove To-do · Task B" })).toBeNull();
      expect(screen.getByRole("list", { name: "Queued prompts" })).toBeDefined();
      expect(focusA().getAttribute("aria-pressed")).toBe("true");

      // A different next-message attachment and later live edits cannot rewrite the queued snapshot.
      await user.click(panel.getByRole("button", { name: "Attach to-do as context: Task A" }));
      await user.click(panel.getByRole("button", { name: "Task B" }));
      act(() => {
        todos = { ...todos, items: [a, { ...b, description: "Changed after send", revision: 1 }] };
        publishTodos();
      });
      await act(async () => admitted.resolve(TurnId.make("10000000-0000-4000-8000-000000000001")));
      expect(screen.getByRole("button", { name: "Remove To-do · Task A" })).toBeDefined();
      expect(submitted.attachments).toEqual([
        {
          kind: "text",
          name: "To-do · Task B",
          text: expect.stringContaining(originalDescription),
        },
      ]);
      expect(submitted.attachments[0]).not.toEqual(
        expect.objectContaining({ text: expect.stringContaining("Changed after send") }),
      );

      prompt.mockRejectedValueOnce(new Error("Admission failed"));
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "Retry this" } });
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(prompt).toHaveBeenCalledTimes(2);
      expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe("Retry this");
      expect(screen.getByRole("button", { name: "Remove To-do · Task A" })).toBeDefined();
      expect(panel.getByRole("button", { name: "Task B" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(prompt.mock.calls[1]![0].attachments).toEqual([
        {
          kind: "text",
          name: "To-do · Task A",
          text: expect.stringContaining("Task A original description"),
        },
      ]);
    } finally {
      view.unmount();
    }
  },
);
