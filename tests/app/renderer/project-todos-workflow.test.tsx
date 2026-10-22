/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import {
  emptyProjectTodos,
  type ProjectTodos,
} from "../../../src/contracts/projects/project-todos";
import { SidebarProjectGroup } from "../../../src/renderer/components/sidebar-project-group";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderTodos(withSidebar = false, selectedSession = "first") {
  let todos: ProjectTodos = {
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
  const sessions = (withSidebar ? ["first", "second", "third"] : ["first", "second"]).map(
    (sessionId) =>
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
  const store = fixture.root.cakeChatCollectionStore.registry.load("project-chat:/cake").todos;
  const { root } = fixture;
  if (withSidebar) root.navigationStore.selectProjectSession(selectedSession);
  const view = render(
    <StoreProvider store={fixture.root}>
      <ProjectTodosPanel store={store} />
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

it("selects description and status while done/reopen remain independent controls", async () => {
  using fixture = renderTodos();
  const title = () => screen.getByRole("button", { name: "Investigate startup" });
  await fixture.user.click(screen.getByText("Find the startup bottleneck."));
  expect(title().getAttribute("aria-pressed")).toBe("true");
  await fixture.user.click(screen.getByText("Report delivered"));
  expect(title().getAttribute("aria-pressed")).toBe("false");
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
  using fixture = renderTodos(true, "third");
  await fixture.user.click(screen.getByRole("button", { name: "Investigate startup" }));
  expect(
    Array.from(
      fixture.container.querySelectorAll("[data-session-id][data-associated=true]"),
      (row) => row.getAttribute("data-session-id"),
    ),
  ).toEqual(["first", "second"]);
  expect(
    fixture.container
      .querySelector('[data-session-id="third"]')
      ?.getAttribute("data-navigation-active"),
  ).toBe("true");
});

it("shares a weak association cue across all linked rows, updates and clears it without changing navigation", async () => {
  using fixture = renderTodos(true);
  const row = (id: string) => fixture.container.querySelector(`[data-session-id="${id}"]`)!;
  const todo = (title: string) => screen.getByRole("button", { name: title });
  const cue = (title: string) => todo(title).parentElement!;
  const associated = () =>
    Array.from(
      fixture.container.querySelectorAll("[data-session-id][data-associated=true]"),
      (item) => item.getAttribute("data-session-id"),
    );
  const expectNavigationUnchanged = () => {
    expect(row("first").getAttribute("data-navigation-active")).toBe("true");
    expect(row("second").getAttribute("data-navigation-active")).toBe("false");
    expect(row("third").getAttribute("data-navigation-active")).toBe("false");
    expect(row("first").className).not.toContain("outline-dashed");
    expect(
      within(row("first") as HTMLElement)
        .getByRole("button", { name: /^first / })
        .getAttribute("aria-current"),
    ).toBe("page");
  };
  expect(associated()).toEqual([]);
  await fixture.user.click(todo("Investigate startup"));
  expect(associated()).toEqual(["second"]);
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
  expect(associated()).toEqual(["third"]);
  expect(cue("Investigate startup").hasAttribute("data-associated")).toBe(false);
  expect(cue("Follow up").getAttribute("data-associated")).toBe("true");
  expectNavigationUnchanged();
  await fixture.user.click(todo("Follow up"));
  expect(associated()).toEqual([]);
  expect(cue("Follow up").hasAttribute("data-associated")).toBe(false);
  await fixture.user.click(todo("Investigate startup"));
  await fixture.user.click(screen.getByRole("button", { name: "Mark done: Investigate startup" }));
  expect(associated()).toEqual([]);
  expectNavigationUnchanged();
});
