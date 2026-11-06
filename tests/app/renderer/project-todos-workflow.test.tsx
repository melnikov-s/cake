/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import {
  emptyProjectTodos,
  projectTodoBaseline,
  type ProjectTodo,
  type ProjectTodos,
  type ProjectTodoUserMutation,
} from "../../../src/contracts/projects/project-todos";
import { localSnoozeDateTime } from "../../../src/renderer/lib/project-todo-snooze";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectChat = "project-chat:/cake";

function renderTodos(
  withSidebar = false,
  initial?: { todos: ProjectTodos; sessions: ReturnType<typeof sessionSummary>[] },
) {
  let todos: ProjectTodos = initial?.todos ?? {
    ...emptyProjectTodos(),
    items: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        title: "Investigate startup",
        description: "Find the startup bottleneck.",
        status: "Report delivered",
        state: "open",
        revision: 0,
        associations: [
          { kind: "session", sessionId: "first", title: "First investigation" },
          { kind: "session", sessionId: "second", title: "Second investigation" },
          { kind: "source", ref: "https://example.com/report", title: "Report" },
          { kind: "source", ref: "cake://session/third", title: "Related report only" },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        title: "Follow up",
        description: "Plan the next step.",
        status: "",
        state: "open",
        revision: 0,
        associations: [{ kind: "session", sessionId: "third", title: "Follow-up session" }],
      },
    ],
  };
  const mutations: ProjectTodoUserMutation[] = [];
  const project = () => ({ ...projectRecord({ path: "/cake" }), todos });
  const sessions =
    initial?.sessions ??
    (withSidebar ? ["first", "second", "third"] : ["first", "second"]).map((sessionId) =>
      sessionSummary({
        sessionId,
        projectPath: "/cake",
        workingDirectory: sessionId === "first" ? "/worktrees/investigation" : "/cake",
        latestTurnOutcome: "complete",
        unread: true,
      }),
    );
  const fixture = createRendererStoreFixture({
    projects: [project()],
    sessions,
    client: {
      projectTodos: {
        mutateUser: async ({ mutation }) => {
          mutations.push(mutation);
          if (mutation._tag === "Select") todos = { ...todos, selectedId: mutation.selectedId };
          if (mutation._tag === "SetState")
            todos = {
              ...todos,
              selectedId: todos.selectedId === mutation.id ? null : todos.selectedId,
              items: todos.items.map((item) => {
                if (item.id !== mutation.id) return item;
                const active = { ...item };
                delete active.snoozedUntil;
                return {
                  ...active,
                  state: mutation.state,
                  needsAttention: false,
                  revision: item.revision + 1,
                };
              }),
            };
          if (mutation._tag === "SetAttention")
            todos = {
              ...todos,
              items: todos.items.map((item) =>
                item.id === mutation.id
                  ? {
                      ...item,
                      needsAttention: mutation.needsAttention,
                      ...(mutation.attentionReason
                        ? { attentionReason: mutation.attentionReason }
                        : null),
                      revision: item.revision + 1,
                    }
                  : item,
              ),
            };
          if (mutation._tag === "Snooze" || mutation._tag === "Unsnooze")
            todos = {
              ...todos,
              selectedId: todos.selectedId === mutation.id ? null : todos.selectedId,
              items: todos.items.map((item) => {
                if (item.id !== mutation.id) return item;
                const active = { ...item };
                delete active.snoozedUntil;
                return {
                  ...active,
                  ...(mutation._tag === "Snooze" ? { snoozedUntil: mutation.until } : {}),
                  revision: item.revision + 1,
                };
              }),
            };
          applySnapshot(fixture.models.projects, { projects: [project()] });
          return todos;
        },
      },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: "project-chat:/cake", title: "Project Chat", projectPath: "/cake" }],
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load(projectChat).todos;
  const { root } = fixture;
  root.navigationStore.selectCakeChat(projectChat);
  store.open();
  const view = render(
    <StoreProvider store={fixture.root}>
      <SideChatLayout
        store={
          root.cakeChatCollectionStore.registry.load(projectChat).conversationSessionStore
            .sideChatStore
        }
        renderChat={() => null}
      >
        <div />
      </SideChatLayout>
      {withSidebar && (
        <SidebarProjectGroup
          cakeChat={root.cakeChatCollectionStore}
          onOpenCakeChat={(id) => void root.navigationStore.openCakeChat(id)}
          store={root.sidebarStore}
          sessionList={root.sidebarStore.sessionListStore}
          sessionMetadata={root.sessionMetadataStore}
          projects={root.projectCatalogStore}
          chat={root.projectWorkbenchStore}
          shell={root.appShellStore}
          appearance={root.settingsStore.appearance}
          path="/cake"
          resolved={false}
          flattenSessions
          onCreateSession={(path) => void root.navigationStore.createSession(path)}
          onOpenSession={(id) => void root.navigationStore.openSession(id)}
          onRemoveProject={(path, deleteSessions) =>
            root.projectRemovalStore.remove(path, deleteSessions)
          }
          onOpenSettings={(path) => root.projectSettingsStore.open(path)}
        />
      )}
    </StoreProvider>,
  );
  let revision = 1;
  return {
    user: userEvent.setup(),
    container: view.container,
    root,
    store,
    todos: () => todos,
    mutations,
    async updateSessions(next: ReturnType<typeof sessionSummary>[]) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: next,
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async updateTodos(next: ProjectTodos) {
      todos = next;
      await act(async () => applySnapshot(fixture.models.projects, { projects: [project()] }));
    },
    associated: () =>
      Array.from(
        view.container.querySelectorAll("[data-session-id][data-associated=true]"),
        (row) => row.getAttribute("data-session-id"),
      ),
    async status(changes: Partial<(typeof sessions)[number]>) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: [{ ...sessions[0]!, recoveryIssue: undefined, ...changes }, sessions[1]!],
          resolvedHasMoreByProject: {},
        }),
      );
    },
    async read() {
      await act(async () =>
        applySessionCatalogGroupUpdate(
          fixture.models.sessionCatalog,
          { projectPath: "/cake", resolved: false },
          {
            _tag: "Event",
            revision: ++revision,
            event: { _tag: "StatusChanged", sessionId: "first", unread: false, resolved: false },
          },
        ),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("renders only nonempty categories with separators between visible sections and preserves disclosure across filtering", async () => {
  using fixture = renderTodos(false, { todos: emptyProjectTodos(), sessions: [] });
  const categories = ["Needs attention", "Active", "Snoozed", "Done"];
  const visibleCategories = () =>
    screen.queryAllByRole("region").map((region) => region.getAttribute("aria-label"));
  expect(visibleCategories()).toEqual([]);
  expect(screen.getByRole("status").textContent).toBe("No to-dos.");

  const items: ProjectTodo[] = [
    { ...todo(100), needsAttention: true, attentionReason: "Review the findings" },
    todo(101),
    { ...todo(102), snoozedUntil: "2099-01-01T00:00:00.000Z" },
    { ...todo(103), state: "done" },
  ];
  await fixture.updateTodos({ ...emptyProjectTodos(), items });
  expect(visibleCategories()).toEqual(categories);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("heading", { name: "Needs attention 1" })).toBeDefined();
  for (const category of categories.slice(1)) {
    expect(screen.getByRole("region", { name: category }).className).toContain("border-t");
    expect(screen.getByRole("button", { name: `${category} (1)` })).toBeDefined();
  }
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  for (const [index, category] of categories.entries()) {
    await fixture.user.clear(search);
    await fixture.user.type(search, items[index]!.title);
    expect(visibleCategories()).toEqual([category]);
    expect(screen.getByRole("region", { name: category }).className).not.toMatch(
      /\b(mt-4|border-t|pt-2)\b/,
    );
    expect(screen.queryByRole("status")).toBeNull();
  }
  await fixture.user.clear(search);
  await fixture.user.type(search, "no such task");
  expect(visibleCategories()).toEqual([]);
  expect(screen.getByRole("status").textContent).toBe("No matching to-dos.");
  await fixture.user.clear(search);
  expect(visibleCategories()).toEqual(categories);
  expect(screen.getByRole("button", { name: "Active (1)" }).getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(screen.queryByRole("list", { name: "Active to-dos" })).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  expect(screen.getByRole("button", { name: items[1]!.title })).toBeDefined();
  expect(fixture.todos().items).toEqual(items);
  expect(fixture.mutations).toEqual([]);
  await fixture.updateTodos(emptyProjectTodos());
  expect(visibleCategories()).toEqual([]);
  expect(screen.getByRole("status").textContent).toBe("No to-dos.");
});

it("shows action-first requests, dismisses without selection/lifecycle effects, restores, and hides retained reasons from search", async () => {
  const item = {
    ...todo(100),
    title: "Startup investigation",
    needsAttention: true,
    attentionReason: "Review the startup findings",
    associations: [
      { kind: "source" as const, ref: "https://example.com/report", title: "Findings" },
    ],
  };
  using fixture = renderTodos(false, {
    todos: {
      ...emptyProjectTodos(),
      items: [
        item,
        todo(101),
        { ...todo(102), snoozedUntil: "2099-01-01T00:00:00.000Z" },
        { ...todo(103), state: "done" },
      ],
    },
    sessions: [],
  });
  const attention = () => screen.getByRole("list", { name: "Needs attention to-dos" });
  expect(within(attention()).getByRole("button", { name: item.title }).textContent).toContain(
    item.attentionReason,
  );
  expect(within(attention()).getByRole("link", { name: "Findings" })).toBeDefined();
  expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
    "Needs attention",
    "Active",
    "Snoozed",
    "Done",
  ]);
  await fixture.user.click(screen.getByRole("button", { name: item.title }));
  const selection = fixture.todos().selectedId;
  expect(
    screen.getAllByRole("button", { name: /^(Unfocus to-do|Dismiss attention):/ }),
  ).toHaveLength(1);
  await fixture.user.click(screen.getByRole("button", { name: `Unfocus to-do: ${item.title}` }));
  expect(fixture.todos().selectedId).toBe(selection);
  expect(fixture.todos().items[0]).toMatchObject({
    state: "open",
    needsAttention: true,
    attentionReason: item.attentionReason,
  });
  expect(fixture.mutations).toEqual([]);
  expect(within(attention()).getByRole("button", { name: item.title })).toBeDefined();
  expect(
    screen.getAllByRole("button", { name: /^(Unfocus to-do|Dismiss attention):/ }),
  ).toHaveLength(1);
  await fixture.user.click(
    screen.getByRole("button", { name: `Dismiss attention: ${item.title}` }),
  );
  expect(screen.getByRole("button", { name: item.title }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(fixture.todos().selectedId).toBe(selection);
  expect(fixture.todos().items[0]).toMatchObject({
    state: "open",
    needsAttention: false,
    attentionReason: item.attentionReason,
  });
  expect(fixture.mutations.map((mutation) => mutation._tag)).toEqual(["SetAttention"]);
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: item.title }));
  const row = within(screen.getByRole("list", { name: "Focus to-dos" })).getByRole("button", {
    name: item.title,
  });
  expect(row.textContent).not.toContain(item.attentionReason);
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  await fixture.user.type(search, "startup findings");
  expect(screen.queryByRole("button", { name: item.title })).toBeNull();
  await fixture.user.clear(search);
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: item.title }),
    keys: "[MouseRight]",
  });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Restore needs attention" }));
  expect(
    within(screen.getByRole("list", { name: "Focus to-dos" })).getByText(item.attentionReason),
  ).toBeDefined();
  expect(fixture.todos().selectedId).toBe(selection);
  await fixture.user.click(screen.getByRole("button", { name: "Active (1)" }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(screen.getByRole("button", { name: "Snoozed (1)" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(
    within(screen.getByRole("list", { name: "Focus to-dos" })).getByText(item.attentionReason),
  ).toBeDefined();
});

it("places Focus above the other four sections without duplicating focused rows", async () => {
  using fixture = renderTodos(false, {
    todos: {
      ...emptyProjectTodos(),
      items: [
        { ...todo(100), needsAttention: true, attentionReason: "Review this" },
        todo(101),
        todo(102),
        { ...todo(103), snoozedUntil: "2099-01-01T00:00:00.000Z" },
        { ...todo(104), state: "done" },
      ],
    },
    sessions: [],
  });
  await fixture.user.click(screen.getByRole("button", { name: "Task 101" }));
  expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
    "Focus",
    "Needs attention",
    "Active",
    "Snoozed",
    "Done",
  ]);
  expect(fixture.container.querySelectorAll(`[data-todo-id="${todo(101).id}"]`)).toHaveLength(1);
  expect(
    within(screen.getByRole("list", { name: "Focus to-dos" })).getByRole("button", {
      name: "Task 101",
    }),
  ).toBeDefined();
});

it("restores every underlying section on explicit unfocus and keeps attachment and attention independent", async () => {
  const items: ProjectTodo[] = [
    { ...todo(100), needsAttention: true, attentionReason: "Review this" },
    todo(101),
    { ...todo(102), snoozedUntil: "2099-01-01T00:00:00.000Z", needsAttention: true },
    { ...todo(103), state: "done" },
  ];
  using fixture = renderTodos(false, { todos: { ...emptyProjectTodos(), items }, sessions: [] });
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  for (const item of items)
    await fixture.user.click(screen.getByRole("button", { name: item.title }));
  const focus = () => within(screen.getByRole("list", { name: "Focus to-dos" }));
  expect(focus().getAllByRole("button", { name: /^Unfocus to-do:/ })).toHaveLength(4);
  expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
    "Focus",
  ]);
  const draft =
    fixture.root.cakeChatCollectionStore.registry.load(projectChat).conversationSessionStore
      .composerStore.draftStore;
  expect(draft.attachments).toHaveLength(0);
  await fixture.user.click(
    focus().getByRole("button", { name: `Attach to-do as context: ${items[0]!.title}` }),
  );
  expect(draft.attachments).toHaveLength(1);
  expect(fixture.store.focusedItems).toHaveLength(4);
  expect(fixture.todos().items).toEqual(items);
  // Attach an unfocused task without focusing it; removing view focus never removes context.
  for (const [index, section] of ["Needs attention", "Active", "Snoozed", "Done"].entries()) {
    const item = items[index]!;
    await fixture.user.click(screen.getByRole("button", { name: `Unfocus to-do: ${item.title}` }));
    expect(
      within(screen.getByRole("list", { name: `${section} to-dos` }))
        .getByRole("button", { name: item.title })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(draft.attachments).toHaveLength(1);
  }
  await fixture.user.click(
    screen.getByRole("button", { name: `Attach to-do as context: ${items[1]!.title}` }),
  );
  expect(draft.attachments).toHaveLength(2);
  expect(fixture.store.focusedItems).toEqual([]);
  expect(fixture.todos().items).toEqual(items);
  expect(fixture.mutations).toEqual([]);
});

it("uses a manual reason editor for Mark/Edit, rejects blank, supports cancel, and keeps snooze precedence", async () => {
  const item = todo(100);
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items: [item] },
    sessions: [],
  });
  const menu = async (label: string) => {
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: item.title }),
      keys: "[MouseRight]",
    });
    await fixture.user.click(screen.getByRole("menuitem", { name: label }));
  };
  await menu("Mark needs attention…");
  await fixture.user.click(screen.getByRole("button", { name: /^Add$/ }));
  expect(screen.getByRole("alert").textContent).toContain("Enter what needs your attention");
  expect(fixture.mutations).toHaveLength(0);
  await fixture.user.type(
    screen.getByRole("textbox", { name: "What needs your attention?" }),
    "Choose sidebar or tabs",
  );
  await fixture.user.click(screen.getByRole("button", { name: /^Add$/ }));
  expect(fixture.mutations.at(-1)).toMatchObject({
    _tag: "SetAttention",
    needsAttention: true,
    attentionReason: "Choose sidebar or tabs",
  });
  await menu("Edit attention reason…");
  expect(
    (screen.getByRole("textbox", { name: "What needs your attention?" }) as HTMLInputElement).value,
  ).toBe("Choose sidebar or tabs");
  await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fixture.mutations).toHaveLength(1);
  await menu("Edit attention reason…");
  const input = screen.getByRole("textbox", { name: "What needs your attention?" });
  await fixture.user.clear(input);
  await fixture.user.type(input, "Review the change before merging");
  await fixture.user.click(screen.getByRole("button", { name: /^Save$/ }));
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: item.title }),
    keys: "[MouseRight]",
  });
  await fixture.user.click(screen.getByRole("menuitem", { name: /^Snooze$/ }));
  await fixture.user.click(screen.getByRole("menuitem", { name: "15 minutes" }));
  expect(
    within(screen.getByRole("list", { name: "Snoozed to-dos" })).getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]?.needsAttention).toBe(true);
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: item.title }),
    keys: "[MouseRight]",
  });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
  expect(
    within(screen.getByRole("list", { name: "Needs attention to-dos" })).getByText(
      "Review the change before merging",
    ),
  ).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: `Mark done: ${item.title}` }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  await fixture.user.click(screen.getByRole("button", { name: `Reopen: ${item.title}` }));
  expect(
    within(screen.getByRole("list", { name: "Active to-dos" })).getByRole("button", {
      name: item.title,
    }),
  ).toBeDefined();
});

function todo(id: number, createdAt?: string, sessionIds: string[] = []): ProjectTodo {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    title: `Task ${id}`,
    description: "Latest finding.",
    status: "",
    state: "open",
    revision: 0,
    ...(createdAt ? { createdAt } : {}),
    associations: sessionIds.map((sessionId) => ({ kind: "session", sessionId, title: sessionId })),
  };
}

const activityTime = (day: number) => `2026-02-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const openOrder = () =>
  Array.from(
    screen.getByRole("list", { name: "Active to-dos" }).querySelectorAll("[data-todo-id]"),
    (row) => row.getAttribute("data-todo-id"),
  );

it("renders newest creation first within all four sections, including live additions and search", async () => {
  const categories = ["Needs attention", "Active", "Snoozed", "Done"];
  const inSection = (item: ProjectTodo, section: number): ProjectTodo =>
    section === 0
      ? { ...item, needsAttention: true, attentionReason: "Review this finding" }
      : section === 2
        ? { ...item, snoozedUntil: "2099-01-01T00:00:00.000Z" }
        : section === 3
          ? { ...item, state: "done" }
          : item;
  // Deliberately neither creation nor ID order.
  const items = categories.flatMap((_, section) =>
    [2, 1, 3].map((day) => inSection(todo(section * 10 + day, activityTime(day)), section)),
  );
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items },
    sessions: [],
  });
  await fixture.user.click(screen.getByRole("button", { name: "Done (3)" }));
  const sectionOrder = (category: string) =>
    Array.from(
      screen.getByRole("list", { name: `${category} to-dos` }).querySelectorAll("[data-todo-id]"),
      (row) => row.getAttribute("data-todo-id"),
    );
  const checkOrder = (days: number[]) => {
    expect(
      screen.getAllByRole("region").map((region) => region.getAttribute("aria-label")),
    ).toEqual(categories);
    categories.forEach((category, section) =>
      expect(sectionOrder(category)).toEqual(days.map((day) => todo(section * 10 + day).id)),
    );
  };
  checkOrder([3, 2, 1]);
  const additions = categories.map((_, section) =>
    inSection(todo(section * 10 + 4, activityTime(4)), section),
  );
  await fixture.updateTodos({ ...fixture.todos(), items: [...items, ...additions] });
  checkOrder([4, 3, 2, 1]);
  expect(fixture.todos().items).toEqual([...items, ...additions]);
  // Search filters the sorted projection rather than falling back to storage order.
  await fixture.user.type(
    screen.getByRole("searchbox", { name: "Search to-dos" }),
    "Latest finding",
  );
  checkOrder([4, 3, 2, 1]);
});

it("breaks equal creation timestamps by ID independently of storage order", () => {
  const items = [
    todo(4, activityTime(1)),
    todo(2, activityTime(2)),
    todo(3, activityTime(1)),
    todo(1, activityTime(2)),
  ];
  for (const order of [items, [...items].reverse()]) {
    using fixture = renderTodos(false, {
      todos: { ...emptyProjectTodos(), items: order },
      sessions: [],
    });
    expect(openOrder()).toEqual([1, 2, 3, 4].map((id) => todo(id).id));
    expect(fixture.todos().items).toEqual(order);
  }
});

it("keeps untimestamped saved items in reverse creation order, unaffected by later edits", async () => {
  const items = [todo(9), todo(2), todo(6)];
  using fixture = renderTodos(false, {
    todos: { ...emptyProjectTodos(), items },
    sessions: [],
  });
  const expected = [6, 2, 9].map((id) => todo(id).id);
  expect(openOrder()).toEqual(expected);
  await fixture.updateTodos({
    ...fixture.todos(),
    items: items.map((item, index) =>
      index === 0
        ? { ...item, description: "Edited old item", modifiedAt: activityTime(10), revision: 1 }
        : item,
    ),
  });
  expect(openOrder()).toEqual(expected);
  await fixture.updateTodos({
    ...fixture.todos(),
    items: [...fixture.todos().items, todo(1, activityTime(1))],
  });
  expect(openOrder()).toEqual([todo(1).id, ...expected]);
});

it("keeps creation order and selection through description/status edits and linked-session activity changes", async () => {
  const items = [todo(1, activityTime(1), ["first"]), todo(2, activityTime(2), ["second"])];
  const sessions = ["first", "second"].map((sessionId) =>
    sessionSummary({
      sessionId,
      projectPath: "/cake",
      unread: true,
      latestTurnOutcome: "complete",
      modifiedAt: activityTime(2),
    }),
  );
  using fixture = renderTodos(false, { todos: { ...emptyProjectTodos(), items }, sessions });
  expect(openOrder()).toEqual([items[1]!.id, items[0]!.id]);
  await fixture.user.click(screen.getByRole("button", { name: "Task 1" }));
  const expected = [items[1]!.id];
  for (const changes of [
    { unread: false },
    { running: true },
    { running: false, modifiedAt: activityTime(9) },
    { recoveryIssue: "Choose the next step" },
  ]) {
    await fixture.updateSessions(
      sessions.map((session) =>
        session.sessionId === "first" ? { ...session, ...changes } : session,
      ),
    );
    expect(openOrder()).toEqual(expected);
  }
  act(() => fixture.root.sessionRegistry.load("first", "/cake").model.activeTurnIds.push("turn"));
  expect(openOrder()).toEqual(expected);
  act(() => fixture.root.sessionRegistry.findModel("first")!.activeTurnIds.splice(0));
  await fixture.updateTodos({
    ...fixture.todos(),
    items: items.map((item, index) =>
      index === 0
        ? {
            ...item,
            modifiedAt: activityTime(10),
            revision: 1,
            description: "New finding.",
            status: "Ready for review",
          }
        : item,
    ),
  });
  expect(openOrder()).toEqual(expected);
  expect(screen.getByText("New finding.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Task 1" }).getAttribute("aria-pressed")).toBe("true");
});

it("filters titles and descriptions without changing selection or the authoritative list", async () => {
  using fixture = renderTodos();
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  const title = () => screen.getByRole("button", { name: "Investigate startup" });
  await fixture.user.click(title());
  await fixture.user.type(search, "FOLLOW");
  expect(screen.getByRole("button", { name: "Follow up" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Investigate startup" })).toBeNull();
  expect(fixture.store.focusedItemIds).toEqual([fixture.todos().items[0]!.id]);
  expect(fixture.todos().items).toHaveLength(2);
  await fixture.user.clear(search);
  await fixture.user.type(search, "BOTTLENECK");
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
  await fixture.user.clear(search);
  await fixture.user.type(search, "Report delivered");
  expect(screen.queryByRole("region", { name: "Active" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("No matching to-dos.");
  await fixture.user.click(screen.getByRole("button", { name: "Clear search to-dos" }));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Follow up" })).toBeDefined();
  await fixture.user.type(search, "   ");
  expect(screen.getAllByRole("button", { name: /^Mark done:/ })).toHaveLength(2);
});

it("keeps matching done items grouped and preserves disclosure and done/reopen actions", async () => {
  using fixture = renderTodos();
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Follow up" }));
  await fixture.user.type(search, "STEP");
  expect(screen.queryByRole("region", { name: "Active" })).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  const done = screen.getByRole("button", { name: "Done (1)" });
  expect(done.getAttribute("aria-expanded")).toBe("false");
  await fixture.user.click(done);
  expect(
    within(screen.getByRole("list", { name: "Done to-dos" })).getByRole("button", {
      name: "Follow up",
    }),
  ).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: "Reopen: Follow up" }));
  expect(
    within(screen.getByRole("list", { name: "Active to-dos" })).getByRole("button", {
      name: "Follow up",
    }),
  ).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Follow up" }));
  expect(screen.getByRole("button", { name: "Done (1)" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  await fixture.user.clear(search);
  await fixture.user.type(search, "no such task");
  expect(screen.queryByRole("region", { name: "Active" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("No matching to-dos.");
  await fixture.user.click(screen.getByRole("button", { name: "Clear search to-dos" }));
  expect(screen.getByRole("list", { name: "Done to-dos" })).toBeDefined();
  expect(screen.getByRole("list", { name: "Active to-dos" })).toBeDefined();
});

it("focuses multiple descriptions idempotently, with independent done/reopen and explicit unfocus", async () => {
  using fixture = renderTodos();
  const title = () => screen.getByRole("button", { name: "Investigate startup" });
  const followUp = () => screen.getByRole("button", { name: "Follow up" });
  await fixture.user.click(screen.getByText("Find the startup bottleneck."));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByText("Plan the next step."));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(followUp().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByText("Plan the next step."));
  expect(followUp().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByText("Find the startup bottleneck."));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Investigate startup" }));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  await fixture.user.click(screen.getByRole("button", { name: "Reopen: Investigate startup" }));
  await fixture.user.click(
    screen.getByRole("button", { name: "Unfocus to-do: Investigate startup" }),
  );
  expect(
    within(screen.getByRole("list", { name: "Active to-dos" }))
      .getByRole("button", { name: "Investigate startup" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

it("keeps each associated session link and projects readiness across read, new work, waiting and settlement", async () => {
  using fixture = renderTodos();
  expect(screen.getByRole("link", { name: "First investigation" }).getAttribute("href")).toBe(
    "cake://session/first",
  );
  expect(screen.getByRole("link", { name: "Second investigation" }).getAttribute("href")).toBe(
    "cake://session/second",
  );
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  await fixture.read();
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  await fixture.status({ running: true, unread: false });
  expect(screen.getByRole("img", { name: "Running" }).className).toContain("bg-accent");
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(1);
  await fixture.status({ running: false, recoveryIssue: "Needs a decision", unread: false });
  expect(screen.getByRole("img", { name: "Needs your input" }).className).toContain("bg-attention");
  await fixture.status({ running: false, unread: false, resolved: true });
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Mark done: Investigate startup" })).toBeDefined();
  await fixture.status({ latestTurnOutcome: "failed" });
  expect(screen.getByRole("img", { name: "Error" }).className).toContain("bg-destructive");
  await fixture.status({ latestTurnOutcome: "aborted" });
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(1);
  await fixture.status({ latestTurnOutcome: undefined, unread: true });
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(1);
});

it("highlights every linked session, including sessions in a managed worktree", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(fixture.associated()).toEqual(["first", "second"]);
  expect(
    fixture.container.querySelectorAll("[data-session-id][data-navigation-active=true]"),
  ).toHaveLength(0);
});

it("distinguishes strong to-do view focus from weak linked-session cues without changing navigation", async () => {
  using fixture = renderTodos(true);
  const row = (id: string) => fixture.container.querySelector(`[data-session-id="${id}"]`)!;
  const todo = (title: string) => screen.getByRole("button", { name: title });
  const cue = (title: string) => todo(title).parentElement!.parentElement!;
  const expectNavigationUnchanged = () => {
    expect(fixture.root.appShellStore.selection).toEqual({
      kind: "cake-chat",
      sessionId: projectChat,
    });
    for (const id of ["first", "second", "third"])
      expect(row(id).getAttribute("data-navigation-active")).toBe("false");
  };
  expect(fixture.associated()).toEqual([]);
  await fixture.user.click(todo("Investigate startup"));
  expect(fixture.associated()).toEqual(["first", "second"]);
  expect(cue("Investigate startup").getAttribute("data-associated")).toBe("true");
  expect(cue("Investigate startup").getAttribute("data-view-focused")).toBe("true");
  expect(cue("Investigate startup").className).toContain("ring-accent");
  expect(cue("Investigate startup").className).toContain("bg-accent/15");
  expect(cue("Investigate startup").className).not.toContain("bg-sidebar-active");
  expect(todo("Investigate startup").getAttribute("aria-pressed")).toBe("true");
  expect(row("second").className).toContain("outline-dashed");
  expect(row("second").className).toContain("bg-sidebar-hover/35");
  expectNavigationUnchanged();
  // A source URL pointing at a session is not a work association.
  expect(row("third").hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(todo("Follow up"));
  expect(fixture.associated()).toEqual(["first", "second", "third"]);
  expect(cue("Investigate startup").getAttribute("data-associated")).toBe("true");
  expect(cue("Follow up").getAttribute("data-associated")).toBe("true");
  expectNavigationUnchanged();
  await fixture.user.click(todo("Follow up"));
  expect(fixture.associated()).toEqual(["first", "second", "third"]);
  await fixture.user.click(screen.getByRole("button", { name: "Unfocus to-do: Follow up" }));
  expect(fixture.associated()).toEqual(["first", "second"]);
  expect(cue("Follow up").hasAttribute("data-associated")).toBe(false);
  expect(cue("Follow up").hasAttribute("data-view-focused")).toBe(false);
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Investigate startup" }));
  expect(fixture.associated()).toEqual(["first", "second"]);
  await fixture.user.click(
    screen.getByRole("button", { name: "Unfocus to-do: Investigate startup" }),
  );
  expect(fixture.associated()).toEqual([]);
  expectNavigationUnchanged();
});

it("closing the to-do panel preserves view focus without attaching composer context", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(fixture.associated()).toEqual(["first", "second"]);
  expect(fixture.store.focusedItemIds).toEqual(["00000000-0000-4000-8000-000000000011"]);
  await act(async () => fixture.store.toggle());
  expect(fixture.store.visible).toBe(false);
  expect(fixture.associated()).toEqual(["first", "second"]);
  expect(fixture.todos().selectedId).toBeNull();
  const baseline = projectTodoBaseline(fixture.todos());
  expect(baseline).toContain('"activeCount":2');
  await act(async () => fixture.store.open());
  expect(
    screen.getByRole("button", { name: "Investigate startup" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("hides the sidebar cue while another conversation is focused and restores it on return", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(fixture.associated()).toEqual(["first", "second"]);
  act(() => fixture.root.navigationStore.selectProjectSession("third"));
  expect(fixture.associated()).toEqual([]);
  act(() => fixture.root.navigationStore.selectCakeChat("cake-chat"));
  expect(fixture.associated()).toEqual([]);
  // Leaving the chat keeps its panel open, so the selection still counts there.
  expect(fixture.store.visible).toBe(true);
  expect(fixture.store.focusedItemIds).toEqual(["00000000-0000-4000-8000-000000000011"]);
  act(() => fixture.root.navigationStore.selectCakeChat(projectChat));
  expect(fixture.associated()).toEqual(["first", "second"]);
});

it("snoozes focused work independently, restores its section on unfocus and unsnoozes early", async () => {
  using fixture = renderTodos();
  const title = "Investigate startup";
  const row = () => screen.getByRole("button", { name: title });
  await fixture.user.click(row());
  const before = Date.now();
  await fixture.user.pointer({ target: row(), keys: "[MouseRight]" });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Snooze" }));
  await fixture.user.click(screen.getByRole("menuitem", { name: "15 minutes" }));
  const mutation = fixture.mutations.at(-1)!;
  expect(mutation).toMatchObject({
    _tag: "Snooze",
    id: fixture.todos().items[0]!.id,
    expectedRevision: 0,
  });
  if (mutation._tag !== "Snooze") throw new Error("Expected snooze mutation");
  expect(new Date(mutation.until).getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000);
  expect(mutation.until).toBe(new Date(mutation.until).toISOString());
  expect(fixture.todos().selectedId).toBeNull();
  expect(
    within(screen.getByRole("list", { name: "Focus to-dos" }))
      .getByRole("button", { name: title })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: `Unfocus to-do: ${title}` }));
  const snoozed = screen.getByRole("list", { name: "Snoozed to-dos" });
  expect(within(snoozed).getByRole("button", { name: title }).getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(within(snoozed).getByRole("link", { name: "Report" })).toBeDefined();
  expect(
    within(screen.getByRole("list", { name: "Active to-dos" })).queryByRole("button", {
      name: title,
    }),
  ).toBeNull();
  const count = fixture.mutations.length;
  await fixture.user.click(row());
  expect(fixture.mutations).toHaveLength(count);
  expect(row().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: `Unfocus to-do: ${title}` }));
  await fixture.user.pointer({ target: row(), keys: "[MouseRight]" });
  await fixture.user.click(screen.getByRole("menuitem", { name: "Unsnooze" }));
  expect(fixture.mutations.at(-1)).toMatchObject({ _tag: "Unsnooze", expectedRevision: 1 });
  expect(
    within(screen.getByRole("list", { name: "Active to-dos" })).getByRole("button", {
      name: title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]!.snoozedUntil).toBeUndefined();
});

it("validates custom local time, changes an existing deadline, searches snoozed work and completes it", async () => {
  using fixture = renderTodos();
  const title = "Investigate startup";
  const openCustom = async (change = false) => {
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: title }),
      keys: "[MouseRight]",
    });
    await fixture.user.click(
      screen.getByRole("menuitem", { name: change ? "Change snooze" : "Snooze" }),
    );
    await fixture.user.click(screen.getByRole("menuitem", { name: "Custom" }));
    expect(screen.getByRole("dialog", { name: "Custom" })).toBeDefined();
    expect(screen.getByRole("grid")).toBeDefined();
    return {
      date: screen.getByLabelText("Date") as HTMLInputElement,
      time: screen.getByLabelText("Time") as HTMLInputElement,
    };
  };
  const input = await openCustom();
  fireEvent.change(input.date, { target: { value: "2000-01-01" } });
  fireEvent.change(input.time, { target: { value: "10:00" } });
  await fixture.user.click(screen.getByRole("button", { name: "Snooze" }));
  expect(screen.getByRole("alert").textContent).toBe("Choose a future date and time.");
  expect(fixture.mutations).toHaveLength(0);
  const future = localSnoozeDateTime(new Date(Date.now() + 2 * 86400_000).toISOString());
  fireEvent.change(input.date, { target: { value: future.split("T")[0] } });
  fireEvent.change(input.time, { target: { value: future.split("T")[1] } });
  await fixture.user.click(screen.getByRole("button", { name: "Snooze" }));
  expect(fixture.mutations.at(-1)).toMatchObject({
    _tag: "Snooze",
    until: new Date(future).toISOString(),
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fixture.container.querySelector("time")?.dateTime).toBe(new Date(future).toISOString());
  const editing = await openCustom(true);
  expect(editing.date.value).toBe(future.split("T")[0]);
  expect(editing.time.value).toBe(future.split("T")[1]);
  const day = new Date(future);
  day.setDate(1);
  day.setMonth(day.getMonth() + 1);
  const later = localSnoozeDateTime(day.toISOString());
  await fixture.user.click(screen.getByRole("button", { name: "Go to the Next Month" }));
  await fixture.user.click(
    within(screen.getByRole("grid")).getByRole("button", {
      name: new RegExp(`${day.toLocaleString("en-US", { month: "long" })} ${day.getDate()}\\D`),
    }),
  );
  expect(editing.date.value).toBe(later.split("T")[0]);
  expect(editing.time.value).toBe(future.split("T")[1]);
  await fixture.user.click(screen.getByRole("button", { name: "Save" }));
  expect(fixture.mutations.at(-1)).toMatchObject({
    _tag: "Snooze",
    expectedRevision: 1,
    until: new Date(later).toISOString(),
  });
  await fixture.user.type(screen.getByRole("searchbox", { name: "Search to-dos" }), "bottleneck");
  expect(
    screen.getByRole("list", { name: "Snoozed to-dos" }).querySelectorAll("[data-todo-id]"),
  ).toHaveLength(1);
  expect(
    fixture.container.querySelectorAll(`[data-todo-id="${fixture.todos().items[0]!.id}"]`),
  ).toHaveLength(1);
  await fixture.user.click(screen.getByRole("button", { name: `Mark done: ${title}` }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(
    within(screen.getByRole("list", { name: "Done to-dos" })).getByRole("button", {
      name: title,
    }),
  ).toBeDefined();
  await fixture.user.pointer({
    target: screen.getByRole("button", { name: title }),
    keys: "[MouseRight]",
  });
  expect(screen.queryByRole("menu")).toBeNull();
  await fixture.user.click(screen.getByRole("button", { name: `Reopen: ${title}` }));
  expect(
    within(screen.getByRole("list", { name: "Active to-dos" })).getByRole("button", {
      name: title,
    }),
  ).toBeDefined();
  expect(fixture.todos().items[0]!.snoozedUntil).toBeUndefined();
});
