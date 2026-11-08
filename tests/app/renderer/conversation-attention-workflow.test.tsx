/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { ManagedRuntime } from "effect";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { CakeChatComposerHeader } from "../../../src/renderer/components/cake-chat-composer-header";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

const item: ProjectTodo = {
  id: "00000000-0000-4000-8000-000000000011",
  title: "Choose shortcut",
  description: "Findings ready",
  status: "",
  state: "open",
  revision: 0,
  associations: [],
  needsAttention: true,
  attentionReason: "Which shortcut should open Quick switcher?",
};
const chat = `project-chat:${"a".repeat(64)}`;

it("shows every own attention item even when focused or filtered; X never activates a report", async () => {
  const calls: unknown[] = [];
  let items = [
    { ...item },
    {
      ...item,
      id: "00000000-0000-4000-8000-000000000012",
      title: "Confirm export",
      attentionReason: "Choose the default export format",
    },
  ];
  const project = () => ({
    ...projectRecord({ path: "/cake" }),
    todos: { ...emptyProjectTodos(), items },
  });
  using fixture = createRendererStoreFixture({
    projects: [project()],
    client: {
      projectTodos: {
        activateAttention: async (input) => {
          calls.push(["activate", input]);
          items = items.map((todo) =>
            todo.id === input.id ? { ...todo, needsAttention: false, revision: 1 } : todo,
          );
          applySnapshot(fixture.models.projects, { projects: [project()] });
          return project().todos;
        },
        mutateUser: async (input) => {
          calls.push(["mutate", input]);
          const mutation = input.mutation;
          if (mutation._tag === "SetAttention")
            items = items.map((todo) =>
              todo.id === mutation.id ? { ...todo, needsAttention: false, revision: 1 } : todo,
            );
          applySnapshot(fixture.models.projects, { projects: [project()] });
          return project().todos;
        },
      },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      { sessionId: chat, title: "Project Chat", projectPath: "/cake" },
      { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
    ],
  });
  const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
  session.todos.query = "no matches";
  session.todos.focusedItemIds = [item.id];
  render(
    <StoreProvider store={fixture.root}>
      <CakeChatComposerHeader session={session} />
    </StoreProvider>,
  );
  const queue = screen.getByRole("region", { name: "Needs attention" });
  expect(within(queue).getAllByRole("button")).toHaveLength(4);
  expect(screen.queryByText("Review")).toBeNull();
  expect(screen.queryByText("This chat’s to-dos")).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Clear attention: Confirm export" })),
  );
  expect(calls).toEqual([
    [
      "mutate",
      {
        scope: "/cake",
        mutation: {
          _tag: "SetAttention",
          id: items[1]!.id,
          expectedRevision: 0,
          needsAttention: false,
        },
      },
    ],
  ]);
  expect(items[1]?.state).toBe("open");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Open attention: Choose shortcut" })),
  );
  expect(calls[1]).toEqual(["activate", { scope: "/cake", id: item.id, expectedRevision: 0 }]);
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  expect(items[0]?.state).toBe("open");
});

it.each([1, 3, 10])("keeps all %i attention items in the inner list and in order", (count) => {
  const items = Array.from({ length: count }, (_, index) => ({
    ...item,
    id: `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
    title: `Finding ${index + 1}`,
    attentionReason: `Review finding ${index + 1}`,
  }));
  using fixture = createRendererStoreFixture({
    projects: [
      {
        ...projectRecord({ path: "/cake" }),
        todos: { ...emptyProjectTodos(), items },
      },
    ],
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: chat, title: "Project Chat", projectPath: "/cake" }],
  });
  const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
  render(
    <StoreProvider store={fixture.root}>
      <CakeChatComposerHeader session={session} />
    </StoreProvider>,
  );
  const queue = screen.getByRole("region", { name: "Needs attention" });
  expect(within(queue).getByRole("heading").textContent).toBe(`Needs attention${count}`);
  const list = within(queue).getByRole("list", { name: "Needs attention items" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(count);
  expect(
    within(list)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(
    items.flatMap((todo) => [`Open attention: ${todo.title}`, `Clear attention: ${todo.title}`]),
  );
});

it("queues authoritative attention occurrences FIFO, not task creation or edit activity", async () => {
  const runtime = ManagedRuntime.make(projectTodoLayer());
  const scope = "/project";
  try {
    // Deliberately create tasks in the opposite order from their requests.
    const tasks: Record<string, ProjectTodo> = {};
    for (const title of ["D", "C", "B", "A"])
      tasks[title] = await runtime.runPromise(
        projectTodos.create(scope, { title, description: "In progress" }),
      );
    const request = async (title: string, attentionReason = `Review ${title}`) => {
      const current = await runtime.runPromise(projectTodos.read(scope, tasks[title]!.id));
      return runtime.runPromise(
        projectTodos.update(scope, {
          id: current.id,
          expectedRevision: current.revision,
          needsAttention: true,
          attentionReason,
        }),
      );
    };
    for (const title of ["A", "B", "C"]) await request(title);
    await runtime.runPromise(
      projectTodos.mutateUser(scope, { _tag: "Select", selectedId: tasks.C!.id }),
    );
    let value = await runtime.runPromise(projectTodos.list(scope));
    const project = () => ({ ...projectRecord({ path: scope }), todos: value });
    const publish = async () => {
      value = await runtime.runPromise(projectTodos.list(scope));
      act(() => applySnapshot(fixture.models.projects, { projects: [project()] }));
    };
    using fixture = createRendererStoreFixture({
      projects: [project()],
      client: {
        projectTodos: {
          mutateUser: async ({ mutation }) => {
            await runtime.runPromise(projectTodos.mutateUser(scope, mutation));
            await publish();
            return value;
          },
        },
      },
    });
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId: chat, title: "Project Chat", projectPath: scope }],
    });
    const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
    const view = render(
      <StoreProvider store={fixture.root}>
        <CakeChatComposerHeader session={session} />
      </StoreProvider>,
    );
    const expectOrder = (titles: string[]) => {
      const list = screen.getByRole("list", { name: "Needs attention items" });
      expect(
        within(list)
          .getAllByRole("listitem")
          .map((row) =>
            within(row)
              .getByRole("button", { name: /^Open attention:/ })
              .getAttribute("aria-label"),
          ),
      ).toEqual(titles.map((title) => `Open attention: ${title}`));
      expect(session.todos.attentionItems.map((todo) => todo.title)).toEqual(titles);
      expect(session.todos.classifiedItems.attention.map((todo) => todo.title)).toEqual(titles);
      expect(value.selectedId).toBe(tasks.C!.id);
    };
    expectOrder(["A", "B", "C"]);
    await request("D");
    await publish();
    expectOrder(["A", "B", "C", "D"]);
    const currentB = await runtime.runPromise(projectTodos.read(scope, tasks.B!.id));
    await runtime.runPromise(
      projectTodos.update(scope, {
        id: currentB.id,
        expectedRevision: currentB.revision,
        description: "Unrelated task update",
        attentionReason: "Reworded pending request",
      }),
    );
    await publish();
    expectOrder(["A", "B", "C", "D"]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Clear attention: A" })),
    );
    expectOrder(["B", "C", "D"]);
    await request("A", "Review genuinely new findings");
    await publish();
    expectOrder(["B", "C", "D", "A"]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Clear attention: D" })),
    );
    await publish();
    expectOrder(["B", "C", "A"]);
    act(() => {
      session.todos.query = "Review";
      session.todos.focusedItemIds = [tasks.C!.id];
    });
    expect(session.todos.attentionItems.map((todo) => todo.title)).toEqual(["B", "C", "A"]);
    expect(session.todos.classifiedItems.attention.map((todo) => todo.title)).toEqual(["A"]);
    view.unmount();
  } finally {
    await runtime.dispose();
  }
});

it.each([undefined, "2026-01-01T00:00:00.000Z"])(
  "keeps legacy and tied occurrences stable with task timestamp %s",
  (timestamp) => {
    const items = [undefined, 2, 2, undefined].map((attentionSequence, index) => ({
      ...item,
      id: `00000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
      title: `Request ${index + 1}`,
      ...(timestamp ? { createdAt: timestamp, modifiedAt: timestamp } : {}),
      ...(attentionSequence === undefined ? {} : { attentionSequence }),
    }));
    using fixture = createRendererStoreFixture({
      projects: [{ ...projectRecord({ path: "/cake" }), todos: { ...emptyProjectTodos(), items } }],
    });
    applySnapshot(fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId: chat, title: "Project Chat", projectPath: "/cake" }],
    });
    const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
    render(
      <StoreProvider store={fixture.root}>
        <CakeChatComposerHeader session={session} />
      </StoreProvider>,
    );
    expect(
      screen
        .getAllByRole("button", { name: /^Open attention:/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([1, 4, 2, 3].map((index) => `Open attention: Request ${index}`));
    expect(session.todos.classifiedItems.attention.map((todo) => todo.title)).toEqual([
      "Request 1",
      "Request 4",
      "Request 2",
      "Request 3",
    ]);
  },
);

it("never borrows the global chat's list and keeps a failed activation visible", async () => {
  using fixture = createRendererStoreFixture({
    projects: [
      {
        ...projectRecord({ path: "/cake" }),
        todos: { ...emptyProjectTodos(), items: [{ ...item, needsAttention: true, revision: 0 }] },
      },
    ],
    client: {
      projectTodos: {
        activateAttention: async () => {
          throw new Error("Report delivery unavailable");
        },
      },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      { sessionId: chat, title: "Project Chat", projectPath: "/cake" },
      { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
    ],
  });
  const global = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const view = render(
    <StoreProvider store={fixture.root}>
      <CakeChatComposerHeader session={global} />
    </StoreProvider>,
  );
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  const session = fixture.root.cakeChatCollectionStore.registry.load(chat);
  view.rerender(
    <StoreProvider store={fixture.root}>
      <CakeChatComposerHeader session={session} />
    </StoreProvider>,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Open attention: Choose shortcut" })),
  );
  expect(screen.getByRole("alert").textContent).toContain("Report delivery unavailable");
  expect(
    screen
      .getByRole("button", { name: "Open attention: Choose shortcut" })
      .hasAttribute("disabled"),
  ).toBe(false);
});
