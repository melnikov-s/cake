/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  emptyProjectTodos,
  type ProjectTodo,
  type ProjectTodos,
  type ProjectTodoUserMutation,
} from "../../../src/contracts/projects/project-todos";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { ChatTranscript } from "../../../src/renderer/components/chat-transcript";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { ProjectTodoSelectionBar } from "../../../src/renderer/components/project-todo-selection-bar";
import { applyPartUpdate } from "../../../src/renderer/reducers/SessionPartReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const a = "00000000-0000-4000-8000-000000000011";
const b = "00000000-0000-4000-8000-000000000012";
const todo = (id: string, title: string): ProjectTodo => ({
  id,
  title,
  description: "",
  status: "",
  state: "open",
  revision: 0,
  associations: [],
});
const user = (id: string, taskTodoId?: string | null): UiPart => ({
  id,
  entryId: id,
  kind: "text",
  role: "user",
  text: id,
  status: "complete",
  ...(taskTodoId === undefined ? { taskAttributionPending: true } : { taskTodoId }),
});
const answer = (id: string): UiPart => ({
  id,
  kind: "text",
  role: "assistant",
  text: id,
  status: "complete",
});

for (const global of [false, true]) {
  it(`folds chronological stretches without changing messages or optional context (${global ? "Cake Chat" : "Project Chat"})`, async () => {
    const sessionId = global ? CAKE_CHAT_SESSION_ID : "project-chat:" + "a".repeat(64);
    let todos: ProjectTodos = {
      ...emptyProjectTodos(),
      items: [todo(a, "Task A"), todo(b, "Task B")],
    };
    const mutations: ProjectTodoUserMutation[] = [];
    const project = () => ({ ...projectRecord({ path: "/cake" }), todos });
    using fixture = createRendererStoreFixture({
      projects: [project()],
      client: {
        projectTodos: {
          mutateUser: async ({ mutation }) => {
            mutations.push(mutation);
            if (mutation._tag !== "Select") throw new Error("Unexpected mutation");
            todos = { ...todos, selectedId: mutation.selectedId };
            publish();
            return todos;
          },
        },
      },
    });
    function publish() {
      if (global) applySnapshot(fixture.models.cakeChatTodos, { todos });
      else applySnapshot(fixture.models.projects, { projects: [project()] });
    }
    publish();
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [
        {
          sessionId,
          title: global ? "Cake Chat" : "Project Chat",
          ...(global ? {} : { projectPath: "/cake" }),
        },
      ],
    });
    const session = fixture.root.cakeChatCollectionStore.registry.load(sessionId);
    const store = session.todos;
    const parts = [
      user("casual", null),
      answer("casual-answer"),
      user("a1", a),
      answer("a1-answer"),
      user("a-followup", a),
      answer("a-followup-answer"),
      user("b1", b),
      answer("b1-answer"),
      user("a2", a),
      answer("a2-answer"),
      user("unassigned", null),
      answer("unassigned-answer"),
    ];
    parts.forEach((part) => applyPartUpdate(session.model.parts, part, sessionId));
    store.open();
    const view = render(
      <StoreProvider store={fixture.root}>
        <ProjectTodoSelectionBar todos={store} />
        <section aria-label="Test transcript">
          <ChatTranscript
            store={session.conversationSessionStore.chatStore}
            behavior={{ todos: store }}
            virtualized={false}
          />
        </section>
        <aside aria-label="To-do">
          <ProjectTodosPanel store={store} />
        </aside>
      </StoreProvider>,
    );
    try {
      const u = userEvent.setup();
      const transcript = within(screen.getByRole("region", { name: "Test transcript" }));
      const panel = within(screen.getByRole("complementary", { name: "To-do" }));
      const headingA = () => transcript.getAllByRole("button", { name: "Task A" });
      const headingB = () => transcript.getByRole("button", { name: "Task B" });
      const expanded = () =>
        [...headingA(), headingB()].map((h) => h.getAttribute("aria-expanded"));
      const readableUnassigned = () => {
        for (const text of ["casual", "casual-answer", "unassigned", "unassigned-answer"]) {
          const message = transcript.getByText(text, { exact: true });
          expect(message.closest("[hidden]")).toBeNull();
          expect(
            message
              .closest('[data-slot="transcript-item"]')
              ?.querySelector('[data-slot="margin-rail"]'),
          ).toBeNull();
        }
      };
      expect(expanded()).toEqual(["true", "true", "true"]);
      await u.click(headingA()[0]!);
      expect(expanded()).toEqual(["false", "true", "true"]);
      expect(transcript.queryByText("a1-answer", { exact: true })).toBeNull();
      expect(transcript.getByText("a2-answer", { exact: true })).toBeDefined();
      await u.click(panel.getByRole("button", { name: "Task B" }));
      expect(store.selectedItem?.id).toBe(b);
      expect(expanded()).toEqual(["false", "false", "true"]);
      readableUnassigned();
      expect(screen.getByText("Currently selected:")).toBeDefined();
      await u.click(headingA()[1]!);
      expect(expanded()).toEqual(["false", "true", "true"]);
      await u.click(panel.getByRole("button", { name: "Task A" }));
      expect(expanded()).toEqual(["true", "true", "false"]);
      await u.click(panel.getByRole("button", { name: "Task A" }));
      expect(store.selectedItem).toBeUndefined();
      expect(expanded()).toEqual(["true", "true", "true"]);
      expect(screen.queryByText("Currently selected:")).toBeNull();

      await u.click(panel.getByRole("button", { name: "Task A" }));
      act(() =>
        session.conversationSessionStore.chatStore.transcriptInteraction.navigateToMessage(
          "b1-answer",
        ),
      );
      expect(transcript.getByText("b1-answer")).toBeDefined();
      expect(store.selectedItem?.id).toBe(a);
      act(() =>
        session.conversationSessionStore.chatStore.transcriptInteraction.clearMessageSelection(),
      );
      act(() => {
        applyPartUpdate(session.model.parts, user("pending"), sessionId);
        applyPartUpdate(session.model.parts, answer("pending-answer"), sessionId);
      });
      expect(transcript.getByText("pending-answer")).toBeDefined();
      expect(
        transcript
          .getByText("pending")
          .closest('[data-slot="transcript-item"]')
          ?.querySelector('[data-slot="margin-rail"]'),
      ).toBeNull();
      act(() => applyPartUpdate(session.model.parts, user("pending", b), sessionId));
      expect(transcript.queryByText("pending-answer")).toBeNull();
      await u.click(screen.getByRole("button", { name: "Clear to-do selection" }));
      expect(todos.selectedId).toBeNull();
      expect(transcript.getByText("pending-answer")).toBeDefined();
      expect(
        transcript
          .getAllByRole("button", { name: "Task B" })
          .map((h) => h.getAttribute("aria-expanded")),
      ).toEqual(["true", "true"]);

      // Authoritative item disappearance invalidates the focus, including manual folds.
      for (const state of ["done", "snoozed", "removed"] as const) {
        await u.click(panel.getByRole("button", { name: "Task A" }));
        await u.click(headingA()[0]!);
        act(() => {
          todos = {
            ...todos,
            selectedId: null,
            items:
              state === "removed"
                ? todos.items.filter((item) => item.id !== a)
                : todos.items.map((item) =>
                    item.id !== a
                      ? item
                      : {
                          ...item,
                          ...(state === "done"
                            ? { state: "done" as const }
                            : { snoozedUntil: "2099-01-01T00:00:00Z" }),
                        },
                  ),
          };
          publish();
        });
        expect(store.selectedItem).toBeUndefined();
        expect(screen.queryByRole("button", { name: "Clear to-do selection" })).toBeNull();
        expect(transcript.getByText("a1-answer")).toBeDefined();
        expect(transcript.getByText("pending-answer")).toBeDefined();
        act(() => {
          todos = { ...todos, items: [todo(a, "Task A"), todo(b, "Task B")] };
          publish();
        });
      }
      expect(session.model.uiParts.map((part) => part.id)).toEqual([
        ...parts.map((part) => part.id),
        "pending",
        "pending-answer",
      ]);
      expect(mutations.every((mutation) => mutation._tag === "Select")).toBe(true);
    } finally {
      view.unmount();
    }
  });
}

it("keeps ordinary Project Sessions outside to-do folding", () => {
  using fixture = createRendererStoreFixture({
    projects: [
      {
        ...projectRecord({ path: "/cake" }),
        todos: {
          ...emptyProjectTodos(),
          selectedId: a,
          items: [todo(a, "Task A"), todo(b, "Task B")],
        },
      },
    ],
    sessions: [sessionSummary({ sessionId: "ordinary", projectPath: "/cake" })],
  });
  const permanentId = "project-chat:" + "a".repeat(64);
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: permanentId, title: "Project Chat", projectPath: "/cake" }],
  });
  const todos = fixture.root.cakeChatCollectionStore.registry.load(permanentId).todos;
  todos.open();
  const ordinary = fixture.root.sessionRegistry.load("ordinary", "/cake");
  [user("b", b), answer("ordinary answer")].forEach((part) =>
    applyPartUpdate(ordinary.model.parts, part, "ordinary"),
  );
  const view = render(
    <ChatTranscript
      store={ordinary.conversationSessionStore.chatStore}
      behavior={{ todos }}
      virtualized={false}
    />,
  );
  try {
    expect(screen.getByText("ordinary answer")).toBeDefined();
    expect(view.container.querySelector('[data-slot="task-section-label"]')).toBeNull();
  } finally {
    view.unmount();
  }
});
