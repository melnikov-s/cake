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

it("updates a section's title and completion live and inspects it without selecting send context", async () => {
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
        <TaskSectionRail
          todoId={item.id}
          start
          todos={store}
          expanded
          editable
          onToggle={() => {}}
        />
        <p>Relevant conversation</p>
        <TaskSectionRail
          todoId={item.id}
          start={false}
          todos={store}
          expanded
          onToggle={() => {}}
        />
        <p>Follow-up</p>
      </section>
      <ProjectTodosPanel store={store} />
    </StoreProvider>,
  );
  try {
    const section = screen.getByRole("region", { name: "Conversation section" });
    // Label picker, title, focus, disclosure and the owning chat's completion action (81947630).
    expect(within(section).getAllByRole("button")).toHaveLength(5);
    const rails = section.querySelectorAll('[data-slot="margin-rail"]');
    expect(rails).toHaveLength(2);
    for (const rail of rails) {
      // Quiet hairline rails (c7c99e7f).
      expect(rail.classList.contains("border-hairline")).toBe(true);
      expect(rail.classList.contains("border-l-2")).toBe(true);
      expect(rail.classList.contains("pointer-events-none")).toBe(true);
    }
    expect(
      within(section)
        .getByRole("button", { name: `Focus to-do: ${item.title}` })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      within(section).getByRole("button", {
        name: `Change label for ${item.title}. Current label: Unlabelled`,
      }),
    ).toBeDefined();
    expect(within(section).getByRole("button", { name: `Mark done: ${item.title}` })).toBeDefined();
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
    act(() =>
      applySnapshot(fixture.models.projects, {
        projects: [project({ ...item, state: "done", status: "Verified", revision: 2 })],
      }),
    );
    expect(within(section).getByRole("button", { name: `Reopen: ${item.title}` })).toBeDefined();
    expect(within(section).getAllByRole("button")).toHaveLength(5);
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: `Show in To-do: ${item.title}` }));
    const doneItems = screen
      .getByRole("list", { name: "To-dos" })
      .querySelector<HTMLElement>('[data-todo-id][data-todo-section="Done"]')!;
    expect(
      within(doneItems)
        .getByRole("button", { name: `Focus to-do: ${item.title}` })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  } finally {
    view.unmount();
  }
});
