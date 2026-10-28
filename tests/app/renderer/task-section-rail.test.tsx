/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { expect, it } from "vitest";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { TaskSectionRail } from "../../../src/renderer/components/task-section-rail";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

it("updates a section's title, status and completion live and inspects it without selecting send context", async () => {
  const item: ProjectTodo = {
    id: "00000000-0000-4000-8000-000000000011",
    title: "Fix artifact-context notices and apparent duplicate messages",
    description: "Verify the transcript presentation.",
    status: "Investigating",
    state: "open",
    revision: 0,
    associations: [],
  };
  const project = (todo: ProjectTodo) => ({
    ...projectRecord({ path: "/cake" }),
    todos: { ...emptyProjectTodos(), items: [todo] },
  });
  using fixture = createRendererStoreFixture({ projects: [project(item)] });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: "project-chat:/cake", title: "Project Chat", projectPath: "/cake" }],
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load("project-chat:/cake").todos;
  const view = render(
    <StoreProvider store={fixture.root}>
      <section aria-label="Conversation section">
        <TaskSectionRail todoId={item.id} start todos={store} />
        <p>Relevant conversation</p>
        <TaskSectionRail todoId={item.id} start={false} todos={store} />
        <p>Follow-up</p>
      </section>
      <ProjectTodosPanel store={store} />
    </StoreProvider>,
  );
  try {
    const section = screen.getByRole("region", { name: "Conversation section" });
    expect(within(section).getAllByRole("button")).toHaveLength(1);
    expect(within(section).getByText("Investigating")).toBeDefined();
    act(() =>
      applySnapshot(fixture.models.projects, {
        projects: [
          project({
            ...item,
            title: "Verify the notice fix",
            status: "Ready for review",
            revision: 1,
          }),
        ],
      }),
    );
    expect(within(section).getByRole("button", { name: "Verify the notice fix" })).toBeDefined();
    expect(within(section).getByText("Ready for review")).toBeDefined();
    act(() =>
      applySnapshot(fixture.models.projects, {
        projects: [project({ ...item, state: "done", status: "Verified", revision: 2 })],
      }),
    );
    expect(within(section).getByText("Done")).toBeDefined();
    expect(within(section).getAllByRole("button")).toHaveLength(1);
    await userEvent.setup().click(within(section).getByRole("button", { name: item.title }));
    const doneItems = screen.getByRole("list", { name: "Done to-dos" });
    expect(
      within(doneItems).getByRole("button", { name: item.title }).getAttribute("aria-pressed"),
    ).toBe("false");
  } finally {
    view.unmount();
  }
});
