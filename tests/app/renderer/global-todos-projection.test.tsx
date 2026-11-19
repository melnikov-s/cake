/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it, vi } from "vitest";
import { defaultProjectSettings } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  type ProjectTodo,
} from "../../../src/contracts/projects/project-todos";
import type { Client } from "../../../src/renderer/client/Client";
import { WorkspaceNavigatorContent } from "../../../src/renderer/components/workspace-navigator-content";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const projectChat = `project-chat:${"a".repeat(64)}`;
const task = (index: number, title: string, extra: Partial<ProjectTodo> = {}): ProjectTodo => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  title,
  description: `${title} description`,
  status: "",
  state: "open",
  revision: 3,
  associations: [],
  ...extra,
});

function setup(sessionId = CAKE_CHAT_SESSION_ID) {
  const mutateUser = vi.fn<Client["projectTodos"]["mutateUser"]>(async () => emptyProjectTodos());
  const activateAttention = vi.fn<Client["projectTodos"]["activateAttention"]>(async () => ({
    todos: emptyProjectTodos(),
    responseTurnId: "turn",
    resultPartIds: [],
    resultSource: "incoming",
  }));
  const reconcile = vi.fn<Client["projectTodos"]["reconcile"]>(async () => undefined);
  const a = task(1, "Investigate startup", { needsAttention: true });
  const b = task(2, "Improve navigation");
  const global = task(3, "Plan my week");
  const fixture = createRendererStoreFixture({
    projects: [
      {
        ...projectRecord({
          path: "/alpha",
          name: "Alpha",
          settings: {
            ...defaultProjectSettings(),
            icon: { mimeType: "image/png", data: "YWJj" },
          },
        }),
        todos: { ...emptyProjectTodos(), items: [a] },
      },
      projectRecord({ path: "/empty", name: "Empty" }),
      {
        ...projectRecord({ path: "/beta", name: "Beta" }),
        todos: {
          ...emptyProjectTodos(),
          items: [
            b,
            task(4, "Shipped", { state: "done" }),
            task(5, "Later", { snoozedUntil: "2099-01-01T00:00:00.000Z" }),
          ],
        },
      },
    ],
    sessions: [sessionSummary({ sessionId: "alpha-session", projectPath: "/alpha" })],
    client: { projectTodos: { mutateUser, activateAttention, reconcile } },
  });
  applySnapshot(fixture.models.cakeChatTodos, {
    todos: { ...emptyProjectTodos(), items: [global] },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
      { sessionId: projectChat, title: "Project Chat", projectPath: "/alpha" },
    ],
  });
  fixture.root.navigationStore.selectCakeChat(sessionId);
  const session = fixture.root.cakeChatCollectionStore.registry.load(sessionId);
  const store = session.todos;
  store.open();
  const view = render(
    <StoreProvider store={fixture.root}>
      <WorkspaceNavigatorContent />
    </StoreProvider>,
  );
  return {
    ...fixture,
    store,
    session,
    mutateUser,
    activateAttention,
    reconcile,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("projects multiple registered lists and global items without copying, omitting empty projects", async () => {
  using f = setup();
  expect(
    Array.from(document.querySelectorAll("[data-todo-group]"), (group) => group.textContent),
  ).toEqual(["Alpha", "Beta", "Global"]);
  expect(screen.queryByText("Empty")).toBeNull();
  for (const title of ["Investigate startup", "Improve navigation", "Plan my week", "Later"])
    expect(screen.getByRole("button", { name: title })).toBeDefined();
  expect(screen.getByRole("button", { name: "Done (1)" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  await f.user.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(screen.getByRole("button", { name: "Shipped" })).toBeDefined();
  const alpha = f.models.projects.find("/alpha")!;
  const beta = f.models.projects.find("/beta")!;
  expect(f.store.paneGroups[0]!.owner.todos).toBe(alpha.todos);
  expect(f.store.paneGroups[0]!.owner.todos.items[0]).toBe(alpha.todos.items[0]);
  expect(f.store.value).toBe(f.models.cakeChatTodos.todos);
  expect(f.store.value!.items).toHaveLength(1);
  expect(f.store.paneOpenCount).toBe(3);
  expect(f.root.workspaceNavigatorStore.todos).toBe(f.store);
  expect(f.root.cakeChatCollectionStore.registry.load(projectChat).todos.value!.items[0]).toBe(
    alpha.todos.items[0],
  );
  expect(f.reconcile.mock.calls.map(([input]) => input.scope)).toEqual([
    "/alpha",
    "/beta",
    CAKE_CHAT_TODO_SCOPE,
  ]);
  act(() => f.store.setQuery("navigation"));
  expect(screen.queryByText("Alpha")).toBeNull();
  expect(screen.queryByText("Global")).toBeNull();
  expect(screen.getByRole("button", { name: "Improve navigation" })).toBeDefined();
  act(() => f.store.setQuery(""));
  expect(screen.getByRole("button", { name: "Done (1)" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  act(() =>
    applySnapshot(beta, {
      ...projectRecord({ path: "/beta", name: "Beta" }),
      todos: emptyProjectTodos(),
    }),
  );
  expect(screen.queryByText("Beta")).toBeNull();
  expect(f.mutateUser).not.toHaveBeenCalled();
});

it("discloses each project independently and retains disclosure across pane switches and snapshots", async () => {
  using f = setup();
  const header = (name: string) => screen.getByRole("button", { name });
  const taskRow = (name: string) => screen.queryByRole("button", { name });
  const alpha = header("Alpha");
  const beta = header("Beta");
  expect(headingIcon(alpha)).toBe("data:image/png;base64,YWJj");
  expect(headingIcon(beta)).toMatch(/^data:image\/svg\+xml/);
  expect(alpha.getAttribute("aria-expanded")).toBe("true");
  expect(beta.getAttribute("aria-expanded")).toBe("true");

  await f.user.click(header("Done (1)"));
  act(() => alpha.focus());
  await f.user.keyboard("{Enter}");
  expect(document.activeElement).toBe(alpha);
  expect(alpha.getAttribute("aria-expanded")).toBe("false");
  expect(taskRow("Investigate startup")).toBeNull();
  expect(taskRow("Improve navigation")).not.toBeNull();
  expect(taskRow("Plan my week")).not.toBeNull();

  await f.user.click(beta);
  expect(beta.getAttribute("aria-expanded")).toBe("false");
  expect(taskRow("Shipped")).toBeNull();
  expect(taskRow("Later")).toBeNull();
  expect(alpha.getAttribute("aria-expanded")).toBe("false");

  const workspace = f.root.workspaceNavigatorStore;
  act(() => workspace.show("sessions"));
  const sessionDisclosure = header("Collapse Alpha");
  expect(sessionDisclosure.getAttribute("aria-expanded")).toBe("true");
  expect(headingIcon(header("Alpha"))).toBe("data:image/png;base64,YWJj");
  await f.user.click(sessionDisclosure);
  act(() => workspace.show("todos"));
  expect(header("Alpha").getAttribute("aria-expanded")).toBe("false");
  expect(header("Beta").getAttribute("aria-expanded")).toBe("false");
  act(() => header("Alpha").focus());
  await f.user.keyboard(" ");
  expect(header("Alpha").getAttribute("aria-expanded")).toBe("true");
  expect(taskRow("Investigate startup")).not.toBeNull();
  expect(header("Beta").getAttribute("aria-expanded")).toBe("false");
  act(() => workspace.show("sessions"));
  expect(header("Expand Alpha")).toBeDefined();
  act(() => workspace.show("todos"));

  const saved = toSnapshot(f.store);
  await f.user.click(header("Beta"));
  expect(taskRow("Shipped")).not.toBeNull();
  act(() => applySnapshot(f.store, saved));
  expect(header("Beta").getAttribute("aria-expanded")).toBe("false");
  expect(taskRow("Shipped")).toBeNull();
});

function headingIcon(button: HTMLElement) {
  return button.querySelector('[data-slot="avatar"] img')?.getAttribute("src");
}

it("searches collapsed projects without overwriting disclosure and reveals only the selected task's project", async () => {
  using f = setup();
  const header = (name: string) => screen.getByRole("button", { name });
  await f.user.click(header("Alpha"));
  await f.user.click(header("Beta"));
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  await f.user.type(search, "navigation");
  expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  expect(header("Beta").getAttribute("aria-expanded")).toBe("true");
  expect(header("Improve navigation")).toBeDefined();
  await f.user.click(header("Beta"));
  expect(screen.queryByRole("button", { name: "Improve navigation" })).toBeNull();
  await f.user.clear(search);
  expect(header("Alpha").getAttribute("aria-expanded")).toBe("false");
  expect(header("Beta").getAttribute("aria-expanded")).toBe("false");

  const done = f.models.projects.find("/beta")!.todos.items.find((item) => item.state === "done")!;
  act(() => f.store.reveal(done));
  expect(header("Beta").getAttribute("aria-expanded")).toBe("true");
  expect(header("Shipped")).toBeDefined();
  expect(header("Alpha").getAttribute("aria-expanded")).toBe("false");
  expect(f.store.inspectedItemId).toBe(done.id);
  expect(f.store.focusedItems).toEqual([]);
});

it("keeps Project Chat scoped to its original list without aggregate headings", () => {
  using f = setup(projectChat);
  expect(f.store.value).toBe(f.models.projects.find("/alpha")!.todos);
  expect(f.store.paneOpenCount).toBe(1);
  expect(screen.getByRole("button", { name: "Investigate startup" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Improve navigation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Plan my week" })).toBeNull();
  expect(document.querySelector("[data-todo-group]")).toBeNull();
  expect(f.reconcile.mock.calls.map(([input]) => input.scope)).toEqual(["/alpha"]);
});

it("routes projected actions to the same original item and scope, including global actions", async () => {
  using f = setup();
  const alpha = f.models.projects.find("/alpha")!.todos.items[0]!;
  const beta = f.models.projects.find("/beta")!.todos.items[0]!;
  const global = f.models.cakeChatTodos.todos.items[0]!;
  await f.user.click(screen.getByRole("button", { name: "Focus to-do: Investigate startup" }));
  expect(f.store.focusedItems[0]).toBe(alpha);
  expect(document.querySelectorAll(`[data-todo-id="${alpha.id}"]`)).toHaveLength(1);
  await f.user.click(screen.getByRole("button", { name: "Mark done: Improve navigation" }));
  expect(f.mutateUser.mock.calls.at(-1)![0]).toEqual({
    scope: "/beta",
    mutation: { _tag: "SetState", id: beta.id, expectedRevision: 3, state: "done" },
  });
  await f.user.click(screen.getByRole("button", { name: "Mark done: Plan my week" }));
  expect(f.mutateUser.mock.calls.at(-1)![0].scope).toBe(CAKE_CHAT_TODO_SCOPE);
  await act(async () => {
    await f.store.snooze(beta, "2099-01-01T00:00:00.000Z");
  });
  expect(f.mutateUser.mock.calls.at(-1)![0]).toMatchObject({
    scope: "/beta",
    mutation: { _tag: "Snooze", id: beta.id },
  });
  const later = f.models.projects.find("/beta")!.todos.items[2]!;
  await act(async () => {
    await f.store.unsnooze(later);
  });
  expect(f.mutateUser.mock.calls.at(-1)![0]).toMatchObject({
    scope: "/beta",
    mutation: { _tag: "Unsnooze", id: later.id },
  });
  await act(async () => {
    await f.store.dismissAttention(alpha);
  });
  expect(f.mutateUser.mock.calls.at(-1)![0]).toMatchObject({
    scope: "/alpha",
    mutation: { _tag: "SetAttention", id: alpha.id, needsAttention: false },
  });
  await act(async () => {
    await f.store.activateAttention(alpha);
  });
  expect(f.activateAttention.mock.calls[0]![0]).toEqual({
    scope: "/alpha",
    id: alpha.id,
    expectedRevision: 3,
  });
  await f.user.click(
    screen.getByRole("button", { name: "Attach to-do as context: Improve navigation" }),
  );
  expect(f.session.conversationSessionStore.chatStore.attachments).toEqual([
    expect.objectContaining({ text: expect.stringContaining("Project Chat (/beta)") }),
  ]);
  expect(f.store.attentionItems).toEqual([]);
  expect(f.store.value!.items[0]).toBe(global);
  // Authoritative edits to the original list appear in both views, without copying or local writes.
  act(() =>
    applySnapshot(f.models.projects.find("/beta")!, {
      ...projectRecord({ path: "/beta", name: "Beta" }),
      todos: {
        ...emptyProjectTodos(),
        items: [{ ...beta, title: "Navigation delivered", state: "done", revision: 4 }],
      },
    }),
  );
  expect(screen.queryByRole("button", { name: "Improve navigation" })).toBeNull();
  await f.user.click(screen.getByRole("button", { name: "Done (1)" }));
  const done = within(screen.getByRole("list", { name: "To-dos" }));
  expect(done.getByRole("button", { name: "Reopen: Navigation delivered" })).toBeDefined();
});
