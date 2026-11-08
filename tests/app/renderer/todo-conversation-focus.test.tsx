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
const user = (id: string, taskTodoId?: string | null): Extract<UiPart, { kind: "text" }> => ({
  id,
  entryId: id,
  kind: "text",
  role: "user",
  text: id,
  status: "complete",
  ...(taskTodoId === undefined ? { taskAttributionPending: true } : { taskTodoId }),
});
const image = (id: string): UiPart => ({
  id,
  kind: "attachment",
  name: `${id}.png`,
  attachmentKind: "image",
  mediaType: "image/png",
  data: "cGl4ZWxz",
});
const answer = (id: string): Extract<UiPart, { kind: "text" }> => ({
  id,
  kind: "text",
  role: "assistant",
  text: id,
  status: "complete",
});

for (const global of [false, true]) {
  it(`switches and clears task focus without changing messages or context (${global ? "Cake Chat" : "Project Chat"})`, async () => {
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
            throw new Error("View focus must not mutate to-dos");
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
      sessions: [{ sessionId, title: "Chat", ...(global ? {} : { projectPath: "/cake" }) }],
    });
    const session = fixture.root.cakeChatCollectionStore.registry.load(sessionId);
    const store = session.todos;
    const parts = [
      user("casual", null),
      answer("casual-answer"),
      user("a1", a),
      image("a1-shot"),
      answer("a1-answer"),
      user("b1", b),
      image("b1-shot"),
      image("b1-detail"),
      answer("b1-answer"),
      user("a2", a),
      answer("a2-answer"),
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
      const headingB = () => transcript.getAllByRole("button", { name: "Task B" })[0]!;
      const expanded = () =>
        [...headingA(), headingB()].map((h) => h.getAttribute("aria-expanded"));
      expect(expanded()).toEqual(["true", "true", "true"]);
      expect(transcript.getByRole("img", { name: "a1-shot.png" })).toBeDefined();
      await u.click(transcript.getByRole("button", { name: "Collapse image: a1-shot.png" }));
      expect(transcript.queryByRole("img", { name: "a1-shot.png" })).toBeNull();
      const navigation = transcript.getAllByRole("button", { name: "Show in To-do: Task A" })[0]!;
      act(() => store.setQuery("not a matching task"));
      await u.click(navigation);
      expect(store.query).toBe("");
      expect(store.focusedItems).toEqual([]);
      await u.click(headingA()[0]!);
      expect(expanded()).toEqual(["false", "true", "true"]);
      await u.click(panel.getByRole("button", { name: "Task B" }));
      expect(transcript.getByText("b1")).toBeDefined();
      expect(transcript.queryByText("a1")).toBeNull();
      expect(transcript.queryByText("casual-answer")).toBeNull();
      expect(transcript.queryByText("b1-answer")).toBeNull();
      expect(transcript.queryByRole("img", { name: "b1-shot.png" })).toBeNull();
      await u.click(panel.getByRole("button", { name: "Task A" }));
      expect(headingA().map((h) => h.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
      expect(transcript.queryByRole("button", { name: "Task B" })).toBeNull();
      expect(transcript.queryByText("b1")).toBeNull();
      expect(transcript.queryByText("a1-answer")).toBeNull();
      expect(store.focusedItems.map((item) => item.id)).toEqual([a]);
      const header = view.container.querySelector('[data-slot="selection-bar"]')!;
      expect(header.textContent).toContain("Focused to-do:Task A");
      expect(header.querySelector("svg")).not.toBeNull();
      expect(
        Array.from(view.container.querySelectorAll("[data-transcript-anchor-id]")).map((row) =>
          row.getAttribute("data-transcript-anchor-id"),
        ),
      ).toEqual(["a1", "a2"]);
      // A hidden attachment must not take the focused section’s disclosure with it.
      await u.click(headingA()[0]!);
      expect(headingA()[0]!.getAttribute("aria-expanded")).toBe("false");
      expect(transcript.queryByText("a1")).toBeNull();
      expect(transcript.getByText("a2")).toBeDefined();
      await u.click(headingA()[0]!);
      expect(transcript.getByText("a1")).toBeDefined();
      // Neither direct navigation nor late untagged input can bypass focus.
      act(() =>
        session.conversationSessionStore.chatStore.transcriptInteraction.navigateToMessage(
          "b1-answer",
        ),
      );
      expect(transcript.queryByText("b1-answer")).toBeNull();
      act(() => {
        applyPartUpdate(session.model.parts, user("pending"), sessionId);
        applyPartUpdate(session.model.parts, answer("pending-answer"), sessionId);
      });
      expect(transcript.queryByText("pending")).toBeNull();
      expect(transcript.queryByText("pending-answer")).toBeNull();
      act(() => applyPartUpdate(session.model.parts, user("pending", b), sessionId));
      expect(transcript.queryByText("pending")).toBeNull();
      // The visible X is keyboard-accessible and restores the normal transcript.
      const clear = screen.getByRole("button", { name: "Clear to-do focus" });
      clear.focus();
      await u.keyboard("{Enter}");
      expect(screen.queryByText("Focused to-do:")).toBeNull();
      expect(transcript.getByText("pending-answer")).toBeDefined();
      expect(transcript.getByText("casual-answer")).toBeDefined();
      expect(transcript.getByText("b1-answer")).toBeDefined();
      expect(store.focusedItems).toEqual([]);
      expect(store.transcriptFocusRequest).toBeUndefined();
      expect(expanded()).toEqual(["true", "true", "true"]);
      // The manual image choice survives filtering and clearing.
      await u.click(transcript.getByRole("button", { name: "Expand image: a1-shot.png" }));
      expect(transcript.getByRole("img", { name: "a1-shot.png" })).toBeDefined();

      // Focus survives lifecycle/attention changes; only removal invalidates it.
      await u.click(panel.getByRole("button", { name: "Task A" }));
      for (const changes of [
        { state: "done" as const },
        { state: "open" as const, snoozedUntil: "2099-01-01T00:00:00Z", needsAttention: true },
      ]) {
        act(() => {
          todos = {
            ...todos,
            items: todos.items.map((item) => (item.id === a ? { ...item, ...changes } : item)),
          };
          publish();
        });
        expect(store.focusedItems.map((item) => item.id)).toEqual([a]);
        expect(headingA().map((h) => h.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
        expect(transcript.queryByRole("button", { name: "Task B" })).toBeNull();
      }
      await u.click(headingA()[0]!);
      act(() => {
        todos = { ...todos, items: todos.items.filter((item) => item.id !== a) };
        publish();
      });
      expect(store.focusedItems).toEqual([]);
      expect(transcript.getByText("a1-answer")).toBeDefined();
      expect(transcript.getByText("b1-answer")).toBeDefined();
      expect(session.model.uiParts.map((part) => part.id)).toEqual([
        ...parts.map((part) => part.id),
        "pending",
        "pending-answer",
      ]);
      expect(mutations).toEqual([]);
    } finally {
      view.unmount();
    }
  });
}

for (const entry of ["pane", "message"] as const) {
  it(`toggles ${entry} focus, reveals the latest task message once and safely ignores missing messages`, async () => {
    using fixture = createRendererStoreFixture();
    applySnapshot(fixture.models.cakeChatTodos, {
      todos: { ...emptyProjectTodos(), items: [todo(a, "Task A"), todo(b, "Task B")] },
    });
    const session = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
    const chat = session.conversationSessionStore.chatStore;
    [
      user("a-first", a),
      answer("a-first-answer"),
      user("a-last", a),
      answer("a-last-answer"),
      user("casual-tail", null),
    ].forEach((part) => applyPartUpdate(session.model.parts, part, session.sessionId));
    session.todos.open();
    const view = render(
      <StoreProvider store={fixture.root}>
        <section aria-label="Transcript">
          <ChatTranscript store={chat} behavior={{ todos: session.todos }} virtualized={false} />
        </section>
        <aside aria-label="To-do">
          <ProjectTodosPanel store={session.todos} />
        </aside>
      </StoreProvider>,
    );
    try {
      const u = userEvent.setup();
      const transcript = within(screen.getByRole("region", { name: "Transcript" }));
      const panel = within(screen.getByRole("complementary", { name: "To-do" }));
      const selected = () =>
        view.container
          .querySelector('[aria-current="true"]')
          ?.getAttribute("data-transcript-anchor-id");
      await u.click(
        entry === "pane"
          ? panel.getByRole("button", { name: "Task A" })
          : transcript.getByRole("button", { name: "Focus to-do: Task A" }),
      );
      expect(selected()).toBe("a-last");
      expect(panel.getByRole("button", { name: "Task A" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      await u.click(
        entry === "pane"
          ? panel.getByRole("button", { name: "Task A" })
          : transcript.getByRole("button", { name: "Focus to-do: Task A" }),
      );
      expect(session.todos.focusedItems).toEqual([]);
      expect(session.todos.transcriptFocusRequest).toBeUndefined();
      expect(panel.getByRole("button", { name: "Task A" }).getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(transcript.getByText("casual-tail")).toBeDefined();
      // A click in the other surface uses the same toggle, not a separate focus state.
      await u.click(
        entry === "pane"
          ? transcript.getByRole("button", { name: "Focus to-do: Task A" })
          : panel.getByRole("button", { name: "Task A" }),
      );
      expect(session.todos.focusedItemIds).toEqual([a]);
      // Attribution/streaming updates must not turn view focus into a live follower.
      act(() => {
        applyPartUpdate(session.model.parts, user("a-new", a), session.sessionId);
        applyPartUpdate(session.model.parts, answer("a-new-answer"), session.sessionId);
      });
      expect(selected()).toBe("a-last");
      await u.click(panel.getByRole("button", { name: "Task B" }));
      expect(selected()).toBeUndefined();
      expect(transcript.getByRole("status").textContent).toBe("No messages tagged to this to-do.");
      expect(transcript.queryByText("casual-tail")).toBeNull();
      expect(panel.getByRole("button", { name: "Task B" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      // A no-match request is consumed, not replayed when a matching message arrives.
      act(() => applyPartUpdate(session.model.parts, user("b-later", b), session.sessionId));
      expect(selected()).toBeUndefined();
    } finally {
      view.unmount();
    }
  });
}

it("filters exact message associations inside grouped history without session or text inference", async () => {
  using fixture = createRendererStoreFixture();
  applySnapshot(fixture.models.cakeChatTodos, {
    todos: {
      ...emptyProjectTodos(),
      items: [
        {
          ...todo(a, "Task A"),
          associations: [
            { kind: "session", sessionId: "source", title: "Source" },
            {
              kind: "source",
              ref: `cake://session/${CAKE_CHAT_SESSION_ID}?message=exact`,
              title: "Exact",
            },
          ],
        },
      ],
    },
  });
  const session = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const parts: UiPart[] = [
    { ...answer("exact"), entryId: "exact", originalHistory: true },
    { ...answer("untagged-history"), originalHistory: true },
    { ...user("Task A", null), agentSource: { title: "Source", href: "cake://session/source" } },
    user("tagged", a),
    answer("untagged-answer"),
  ];
  parts.forEach((part) => applyPartUpdate(session.model.parts, part, session.sessionId));
  const view = render(
    <ChatTranscript
      store={session.conversationSessionStore.chatStore}
      behavior={{ todos: session.todos }}
      virtualized={false}
    />,
  );
  try {
    act(() => session.todos.toggleFocus(session.todos.value!.items[0]!));
    expect(screen.getByText("tagged")).toBeDefined();
    expect(screen.queryByText("untagged-answer")).toBeNull();
    expect(screen.queryByText("Source")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: /Original history/ }));
    expect(screen.getByText("exact")).toBeDefined();
    expect(screen.queryByText("untagged-history")).toBeNull();
    act(() => session.todos.clearFocus());
    expect(screen.getByText("untagged-answer")).toBeDefined();
    expect(screen.getByText("untagged-history")).toBeDefined();
    expect(session.model.uiParts.map((part) => part.id)).toEqual(parts.map((part) => part.id));
  } finally {
    view.unmount();
  }
});

it("interrupts source rows without changing the discussion or borrowing pane selection", async () => {
  const sourceA = "20000000-0000-4000-8000-000000000011";
  const sourceB = "20000000-0000-4000-8000-000000000012";
  using fixture = createRendererStoreFixture();
  applySnapshot(fixture.models.cakeChatTodos, {
    todos: {
      ...emptyProjectTodos(),
      items: [
        {
          ...todo(a, "Task A"),
          associations: [{ kind: "session", sessionId: sourceA, title: "Source A" }],
        },
        {
          ...todo(b, "Task B"),
          associations: [{ kind: "session", sessionId: sourceB, title: "Source B" }],
        },
      ],
    },
  });
  const session = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const report: UiPart = {
    id: "b-report",
    entryId: "b-report",
    kind: "text",
    role: "user",
    text: "B findings",
    status: "complete",
    crossSession: {
      version: 1,
      messageId: "10000000-0000-4000-8000-000000000001",
      threadId: "10000000-0000-4000-8000-000000000001",
      sequence: 1,
      expectsResponse: false,
      sender: { sessionId: sourceB, title: "Source B", kind: "project-session" },
    },
  };
  const parts: UiPart[] = [
    user("a-discussion", a),
    answer("a-answer"),
    report,
    {
      id: "b-card",
      kind: "tool",
      name: "cake",
      input: "",
      state: "success",
      messageReference: `cake://session/${sourceB}?message=original`,
    },
    {
      id: "unknown-report",
      kind: "text",
      role: "assistant",
      text: "Unassigned findings",
      status: "complete",
      agentSource: { title: "Unknown source", href: "cake://session/untracked" },
    },
    answer("a-continuation"),
    {
      id: "matching-report",
      kind: "text",
      role: "assistant",
      text: "A findings",
      status: "complete",
      agentSource: { title: "Source A", href: `cake://session/${sourceA}` },
    },
    answer("a-after-matching"),
  ];
  parts.forEach((part) => applyPartUpdate(session.model.parts, part, CAKE_CHAT_SESSION_ID));
  const view = render(
    <StoreProvider store={fixture.root}>
      <ChatTranscript
        store={session.conversationSessionStore.chatStore}
        behavior={{ todos: session.todos }}
        virtualized={false}
      />
    </StoreProvider>,
  );
  try {
    const u = userEvent.setup();
    const row = (id: string) =>
      view.container.querySelector(`[data-transcript-anchor-id="${id}"]`)!;
    const rail = (id: string) => row(id).querySelector('[data-slot="margin-rail"]');
    const headings = () => screen.getAllByRole("button", { name: /^Task [AB]$/ });
    expect(session.todos.focusedItems).toEqual([]);
    expect(headings().map((h) => h.getAttribute("aria-label"))).toEqual([
      "Task A",
      "Task B",
      "Task A",
    ]);
    expect(rail("b-report")).not.toBeNull();
    expect(row("b-report").textContent).toContain("Task B");
    expect(row("b-report").textContent).not.toContain("Task A");
    expect(rail("b-card")).not.toBeNull();
    expect(rail("unknown-report")).toBeNull();
    expect(rail("a-continuation")).not.toBeNull();
    expect(row("a-continuation").textContent).toContain("Task A");
    expect(rail("matching-report")).not.toBeNull();
    expect(rail("a-after-matching")).not.toBeNull();

    // A collapsed unrelated to-do row never joins the surrounding A rail.
    await u.click(screen.getByRole("button", { name: "Task B" }));
    expect(rail("b-report")).toBeNull();
    expect(view.container.querySelector('[data-transcript-anchor-id="b-card"]')).toBeNull();
    expect(screen.getByText("a-continuation")).toBeDefined();
    expect(rail("a-continuation")).not.toBeNull();
    await u.click(screen.getAllByRole("button", { name: "Task A" })[0]!);
    expect(screen.queryByText("a-answer")).toBeNull();
    expect(screen.getByText("a-after-matching")).toBeDefined();
    expect(screen.getByText("Unknown source")).toBeDefined();
    await u.click(screen.getByRole("button", { name: "Task B" }));
    expect(rail("b-card")).not.toBeNull();
    expect(session.todos.focusedItems).toEqual([]);
    expect(session.model.uiParts.map((part) => part.id)).toEqual(parts.map((part) => part.id));
  } finally {
    view.unmount();
  }
});

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
