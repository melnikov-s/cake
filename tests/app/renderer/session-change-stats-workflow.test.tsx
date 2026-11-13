/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, render, within } from "@testing-library/react";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { ProjectTodoItem } from "../../../src/renderer/components/project-todo-item";
import { applyManagedWorktreeCatalogUpdate } from "../../../src/renderer/reducers/WorktreeCatalogReducer";
import type { WorktreeCatalogEntry } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it("shares live stats across session lists and distinct to-do session links, hiding empty/missing ranges", async () => {
  const ids = ["committed", "other", "empty", "plain", "missing"];
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: ids
      .filter((id) => id !== "missing")
      .map((sessionId) =>
        sessionSummary({ sessionId, projectPath: "/project", workingDirectory: `/${sessionId}` }),
      ),
  });
  const record: WorktreeCatalogEntry = {
    projectPath: "/project",
    worktreePath: "/committed",
    branch: "agent/task",
    baseBranch: "main",
    state: "active",
    createdAt: "",
    contributionStats: { unavailableReason: null, additions: 120, deletions: 35 },
  };
  applyManagedWorktreeCatalogUpdate(fixture.models.worktrees, {
    _tag: "Snapshot",
    worktrees: [
      record,
      {
        ...record,
        worktreePath: "/other",
        branch: "agent/other",
        contributionStats: { unavailableReason: null, additions: 4, deletions: 2 },
      },
      {
        ...record,
        worktreePath: "/empty",
        branch: "agent/empty",
        contributionStats: { unavailableReason: null, additions: 0, deletions: 0 },
      },
    ],
  });
  const item: ProjectTodo = {
    id: "todo",
    title: "Review",
    description: "Review",
    state: "open",
    status: "",
    revision: 0,
    associations: [...ids, "committed"].map((sessionId) => ({
      kind: "session",
      sessionId,
      title: sessionId,
    })),
  };
  const store = fixture.root.cakeChatCollectionStore.registry.load("project-chat:test").todos;
  const view = render(
    <StrictMode>
      <StoreProvider store={fixture.root}>
        <ConversationNavigator projectPath="/project" />
        <ProjectTodoItem item={item} store={store} />
      </StoreProvider>
    </StrictMode>,
  );
  const row = view.container.querySelector<HTMLElement>('[data-session-id="committed"]')!;
  const todo = view.container.querySelector<HTMLElement>('[data-todo-id="todo"]')!;
  expect(within(row).getByRole("img", { name: "Contribution: +120 −35" })).toBeDefined();
  expect(within(todo).getAllByRole("img", { name: "Contribution: +120 −35" })).toHaveLength(1);
  expect(within(todo).getByRole("img", { name: "Contribution: +4 −2" })).toBeDefined();
  expect(todo.querySelectorAll('[data-slot="contribution-stats"]')).toHaveLength(2);
  // One shared component: the same contribution deltas in both places.
  const todoStats = within(todo).getByRole("img", { name: "Contribution: +120 −35" });
  for (const stats of [
    within(row).getByRole("img", { name: "Contribution: +120 −35" }),
    todoStats,
  ]) {
    expect(within(stats).getByText("+120").classList.contains("text-success")).toBe(true);
    expect(within(stats).getByText("−35").classList.contains("text-destructive")).toBe(true);
  }
  expect(within(todoStats).queryByText(/commits/)).toBeNull();
  // Plain session title (no prose chip) with the stats on their own line beneath it.
  const committedLink = within(todo).getByRole("link", { name: "committed" });
  expect(todoStats.previousElementSibling).toBe(committedLink);
  expect(committedLink.parentElement!.classList.contains("flex-col")).toBe(true);
  expect(committedLink.className).not.toMatch(/max-w-64|bg-accent/);
  expect(within(todo).getAllByRole("link", { name: "committed" })).toHaveLength(1);
  for (const id of ids) expect(within(todo).getByRole("link", { name: id })).toBeDefined();
  expect(within(todo).getByRole("button", { name: "Mark done: Review" })).toBeDefined();
  await act(async () => {
    applyManagedWorktreeCatalogUpdate(fixture.models.worktrees, {
      _tag: "Event",
      event: {
        _tag: "Upserted",
        worktree: {
          ...record,
          contributionStats: { unavailableReason: null, additions: 130, deletions: 36 },
        },
      },
    });
  });
  expect(within(row).getByRole("img", { name: "Contribution: +130 −36" })).toBeDefined();
  expect(within(todo).getByRole("img", { name: "Contribution: +130 −36" })).toBeDefined();
  await act(async () => {
    applyManagedWorktreeCatalogUpdate(fixture.models.worktrees, {
      _tag: "Event",
      event: { _tag: "Upserted", worktree: { ...record, contributionStats: undefined } },
    });
  });
  expect(row.querySelector('[data-slot="contribution-stats"]')).toBeNull();
  expect(todo.querySelectorAll('[data-slot="contribution-stats"]')).toHaveLength(1);
  view.unmount();
});
