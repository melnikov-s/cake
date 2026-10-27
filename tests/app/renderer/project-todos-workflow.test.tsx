/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import {
  emptyProjectTodos,
  projectTodoBaseline,
  type ProjectTodo,
  type ProjectTodos,
} from "../../../src/contracts/projects/project-todos";
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
          if (mutation._tag === "Select") todos = { ...todos, selectedId: mutation.selectedId };
          if (mutation._tag === "SetState")
            todos = {
              ...todos,
              selectedId: todos.selectedId === mutation.id ? null : todos.selectedId,
              items: todos.items.map((item) =>
                item.id === mutation.id
                  ? { ...item, state: mutation.state, revision: item.revision + 1 }
                  : item,
              ),
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

function todo(id: number, modifiedAt?: string, sessionIds: string[] = []): ProjectTodo {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    title: `Task ${id}`,
    description: "Latest finding.",
    status: "",
    state: "open",
    revision: 0,
    ...(modifiedAt ? { modifiedAt } : {}),
    associations: sessionIds.map((sessionId) => ({ kind: "session", sessionId, title: sessionId })),
  };
}

const activityTime = (day: number) => `2026-02-${String(day).padStart(2, "0")}T00:00:00.000Z`;
const openOrder = () =>
  Array.from(
    screen.getByRole("list", { name: "Open to-dos" }).querySelectorAll("[data-todo-id]"),
    (row) => row.getAttribute("data-todo-id"),
  );

it("groups unread, other and active work with newest activity first and running overriding unread", () => {
  const sessions = [
    sessionSummary({
      sessionId: "unread-old",
      projectPath: "/cake",
      unread: true,
      latestTurnOutcome: "complete",
      modifiedAt: activityTime(1),
    }),
    sessionSummary({
      sessionId: "unread-new",
      projectPath: "/cake",
      unread: true,
      latestTurnOutcome: "complete",
      modifiedAt: activityTime(3),
    }),
    sessionSummary({
      sessionId: "read-old",
      projectPath: "/cake",
      latestTurnOutcome: "complete",
      modifiedAt: activityTime(2),
    }),
    sessionSummary({
      sessionId: "read-new",
      projectPath: "/cake",
      latestTurnOutcome: "complete",
      modifiedAt: activityTime(9),
    }),
    sessionSummary({
      sessionId: "running-old",
      projectPath: "/cake",
      running: true,
      modifiedAt: activityTime(8),
    }),
    sessionSummary({
      sessionId: "running-new",
      projectPath: "/cake",
      running: true,
      unread: true,
      modifiedAt: activityTime(10),
    }),
  ];
  const items = [
    todo(8, undefined, ["running-new", "unread-old"]),
    todo(1, undefined, ["read-old"]),
    todo(7, undefined, ["running-old"]),
    todo(3, undefined, ["unread-old"]),
    {
      ...todo(6, activityTime(7)),
      // Context must not acquire the running/unread state of its target.
      associations: [
        { kind: "source" as const, ref: "cake://session/running-new", title: "Context" },
      ],
    },
    todo(4, undefined, ["unread-new"]),
    todo(5), // Older saved item, with neither a timestamp nor known work.
    todo(2, undefined, ["read-new"]),
  ];
  using fixture = renderTodos(false, { todos: { ...emptyProjectTodos(), items }, sessions });
  expect(openOrder()).toEqual([4, 3, 2, 6, 1, 5, 8, 7].map((id) => todo(id).id));
  expect(screen.queryByRole("combobox", { name: "Sort to-dos" })).toBeNull();
  expect(fixture.todos().items).toEqual(items); // Ordering never rewrites storage.
});

it("breaks equal and missing activity ties by ID, independent of incoming storage order", () => {
  const items = [todo(4), todo(2, activityTime(2)), todo(3), todo(1, activityTime(2))];
  const expected = [1, 2, 3, 4].map((id) => todo(id).id);
  for (const order of [items, [...items].reverse()]) {
    using fixture = renderTodos(false, {
      todos: { ...emptyProjectTodos(), items: order },
      sessions: [],
    });
    expect(openOrder()).toEqual(expected);
    expect(fixture.todos().items).toEqual(order);
  }
});

it("reorders live on read, running, settlement and activity changes without reopening or losing selection", async () => {
  const items = [todo(1, undefined, ["first"]), todo(2, undefined, ["second"])];
  let sessions = ["first", "second"].map((sessionId, index) =>
    sessionSummary({
      sessionId,
      projectPath: "/cake",
      unread: true,
      latestTurnOutcome: "complete",
      modifiedAt: activityTime(index + 1),
    }),
  );
  using fixture = renderTodos(false, { todos: { ...emptyProjectTodos(), items }, sessions });
  const ids = items.map(({ id }) => id);
  expect(openOrder()).toEqual([...ids].reverse());
  await fixture.user.click(screen.getByRole("button", { name: "Task 2" }));
  // Read acknowledgement demotes a task even though its work chip remains green/ready.
  sessions = sessions.map((session) => ({ ...session, unread: session.sessionId === "first" }));
  await fixture.updateSessions(sessions);
  expect(openOrder()).toEqual(ids);
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  sessions = sessions.map((session) => ({ ...session, running: session.sessionId === "first" }));
  await fixture.updateSessions(sessions);
  expect(openOrder()).toEqual([...ids].reverse());
  sessions = sessions.map((session) => ({ ...session, running: false }));
  await fixture.updateSessions(sessions);
  expect(openOrder()).toEqual(ids);
  sessions = sessions.map((session) => ({ ...session, unread: false }));
  await fixture.updateSessions(sessions);
  expect(openOrder()).toEqual([...ids].reverse());
  sessions = sessions.map((session) =>
    session.sessionId === "first" ? { ...session, modifiedAt: activityTime(3) } : session,
  );
  await fixture.updateSessions(sessions);
  expect(openOrder()).toEqual(ids);
  // Accepted live turns take precedence before the catalog's running flag catches up.
  act(() => fixture.root.sessionRegistry.load("first", "/cake").model.activeTurnIds.push("turn"));
  expect(openOrder()).toEqual([...ids].reverse());
  act(() => fixture.root.sessionRegistry.findModel("first")!.activeTurnIds.splice(0));
  expect(openOrder()).toEqual(ids);
  await fixture.updateTodos({
    ...fixture.todos(),
    items: items.map((item) =>
      item.id === ids[1]
        ? { ...item, modifiedAt: activityTime(4), revision: 1, description: "New finding." }
        : item,
    ),
  });
  expect(openOrder()).toEqual([...ids].reverse());
  expect(screen.getByText("New finding.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Task 2" }).getAttribute("aria-pressed")).toBe("true");
});

it("filters titles and descriptions without changing selection or the authoritative list", async () => {
  using fixture = renderTodos();
  const search = screen.getByRole("searchbox", { name: "Search to-dos" });
  const title = () => screen.getByRole("button", { name: "Investigate startup" });
  await fixture.user.click(title());
  await fixture.user.type(search, "FOLLOW");
  expect(screen.getByRole("button", { name: "Follow up" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Investigate startup" })).toBeNull();
  expect(fixture.todos().selectedId).toBe(fixture.todos().items[0]!.id);
  expect(fixture.todos().items).toHaveLength(2);
  await fixture.user.clear(search);
  await fixture.user.type(search, "BOTTLENECK");
  expect(title().getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
  await fixture.user.clear(search);
  await fixture.user.type(search, "Report delivered");
  expect(screen.getByRole("status").textContent).toContain("No matching to-dos");
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
  expect(screen.getByRole("status").textContent).toBe("No matching open to-dos.");
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
    within(screen.getByRole("list", { name: "Open to-dos" })).getByRole("button", {
      name: "Follow up",
    }),
  ).toBeDefined();
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Follow up" }));
  expect(screen.getByRole("button", { name: "Done (1)" }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  await fixture.user.clear(search);
  await fixture.user.type(search, "no such task");
  expect(screen.getByRole("status").textContent).toContain("No matching to-dos");
  await fixture.user.click(screen.getByRole("button", { name: "Clear search to-dos" }));
  expect(screen.getByRole("list", { name: "Done to-dos" })).toBeDefined();
  expect(screen.getByRole("list", { name: "Open to-dos" })).toBeDefined();
});

it("selects the latest description while done/reopen remain independent controls", async () => {
  using fixture = renderTodos();
  const title = () => screen.getByRole("button", { name: "Investigate startup" });
  const followUp = () => screen.getByRole("button", { name: "Follow up" });
  await fixture.user.click(screen.getByText("Find the startup bottleneck."));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByText("Plan the next step."));
  expect(title().getAttribute("aria-pressed")).toBe("false");
  expect(followUp().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByText("Plan the next step."));
  expect(followUp().getAttribute("aria-pressed")).toBe("false");
  await fixture.user.click(screen.getByText("Find the startup bottleneck."));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Investigate startup" }));
  await fixture.user.click(screen.getByRole("button", { name: "Done (1)" }));
  expect(title().getAttribute("aria-pressed")).toBe("false");
  expect(screen.getAllByRole("img", { name: "Ready for review" })).toHaveLength(2);
  await fixture.user.click(screen.getByRole("button", { name: "Reopen: Investigate startup" }));
  expect(
    within(screen.getByRole("list", { name: "Open to-dos" }))
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

it("shares a weak association cue across all linked rows, updates and clears it without changing navigation", async () => {
  using fixture = renderTodos(true);
  const row = (id: string) => fixture.container.querySelector(`[data-session-id="${id}"]`)!;
  const todo = (title: string) => screen.getByRole("button", { name: title });
  const cue = (title: string) => todo(title).parentElement!;
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
  expect(cue("Investigate startup").className).toContain("outline-dashed");
  expect(cue("Investigate startup").className).toContain("bg-sidebar-hover/35");
  expect(cue("Investigate startup").className).not.toContain("bg-sidebar-active");
  expect(todo("Investigate startup").getAttribute("aria-pressed")).toBe("true");
  expect(row("second").className).toContain("outline-dashed");
  expect(row("second").className).toContain("bg-sidebar-hover/35");
  expectNavigationUnchanged();
  // A source URL pointing at a session is not a work association.
  expect(row("third").hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(todo("Follow up"));
  expect(fixture.associated()).toEqual(["third"]);
  expect(cue("Investigate startup").hasAttribute("data-associated")).toBe(false);
  expect(cue("Follow up").getAttribute("data-associated")).toBe("true");
  expectNavigationUnchanged();
  await fixture.user.click(todo("Follow up"));
  expect(fixture.associated()).toEqual([]);
  expect(cue("Follow up").hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(todo("Investigate startup"));
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Investigate startup" }));
  expect(fixture.associated()).toEqual([]);
  expectNavigationUnchanged();
});

it("closing the to-do panel clears the selection for the sidebar and the agent context", async () => {
  using fixture = renderTodos(true);
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(fixture.associated()).toEqual(["first", "second"]);
  expect(fixture.todos().selectedId).toBe("00000000-0000-4000-8000-000000000011");
  await act(async () => fixture.store.toggle());
  expect(fixture.store.visible).toBe(false);
  expect(fixture.associated()).toEqual([]);
  expect(fixture.todos().selectedId).toBeNull();
  const baseline = projectTodoBaseline(fixture.todos());
  expect(baseline).toContain('"selectedId":null');
  expect(baseline).toContain('"selected":null');
  await act(async () => fixture.store.open());
  expect(
    screen.getByRole("button", { name: "Investigate startup" }).getAttribute("aria-pressed"),
  ).toBe("false");
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
  expect(fixture.todos().selectedId).toBe("00000000-0000-4000-8000-000000000011");
  act(() => fixture.root.navigationStore.selectCakeChat(projectChat));
  expect(fixture.associated()).toEqual(["first", "second"]);
});
