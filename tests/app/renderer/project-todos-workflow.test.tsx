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
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { applySessionCatalogGroupUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function renderTodos() {
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
        ],
      },
    ],
  };
  const project = () => ({ ...projectRecord({ path: "/cake" }), todos });
  const sessions = ["first", "second"].map((sessionId) =>
    sessionSummary({
      sessionId,
      projectPath: "/cake",
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
  const view = render(
    <StoreProvider store={fixture.root}>
      <ProjectTodosPanel store={store} />
    </StoreProvider>,
  );
  let revision = 1;
  return {
    user: userEvent.setup(),
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
