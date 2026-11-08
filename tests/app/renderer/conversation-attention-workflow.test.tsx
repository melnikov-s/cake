/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { CakeChatComposerHeader } from "../../../src/renderer/components/cake-chat-composer-header";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

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
