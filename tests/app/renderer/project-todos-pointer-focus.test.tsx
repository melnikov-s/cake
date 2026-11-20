/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { forwardRef, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyProjectTodos, type ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { ProjectTodosPanel } from "../../../src/renderer/components/project-todos-panel";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Observe the list's always-render keys without replacing the list itself.
const alwaysRendered: Array<readonly string[] | undefined> = [];
vi.mock("@legendapp/list/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@legendapp/list/react")>();
  const Original = actual.LegendList as unknown as (
    props: Record<string, unknown>,
  ) => React.ReactNode;
  return {
    ...actual,
    LegendList: forwardRef<unknown, ComponentProps<typeof actual.LegendList>>((props, ref) => {
      alwaysRendered.push(
        (props as { alwaysRender?: { keys?: readonly string[] } }).alwaysRender?.keys,
      );
      return <Original {...(props as Record<string, unknown>)} ref={ref} />;
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  alwaysRendered.length = 0;
});

const task = (id: string, title: string): ProjectTodo => ({
  id,
  title,
  description: `${title} details`,
  status: "",
  state: "open",
  revision: 0,
  associations: [],
});

it("keeps a pressed row in place until the press completes, then retains it as the keyboard owner", () => {
  vi.useFakeTimers();
  const items = [
    task("00000000-0000-4000-8000-000000000011", "Task A"),
    task("00000000-0000-4000-8000-000000000012", "Task B"),
  ];
  using fixture = createRendererStoreFixture({
    projects: [{ ...projectRecord({ path: "/alpha" }), todos: { ...emptyProjectTodos(), items } }],
  });
  const chatId = "project-chat:/alpha";
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: chatId, title: "Project Chat", projectPath: "/alpha" }],
  });
  const store = fixture.root.cakeChatCollectionStore.registry.load(chatId).todos;
  render(
    <StoreProvider store={fixture.root}>
      <ProjectTodosPanel store={store} />
    </StoreProvider>,
  );
  const latest = () => alwaysRendered.at(-1);
  const focusB = screen.getByRole("button", { name: "Focus to-do: Task B" });
  // Re-rendering the pressed row into the always-render slot mid-press moves it under the
  // pointer, so the release would miss the Focus control.
  fireEvent.pointerDown(focusB);
  act(() => focusB.focus());
  expect(latest()).toBeUndefined();
  fireEvent.pointerUp(focusB);
  fireEvent.click(focusB);
  expect(focusB.getAttribute("aria-pressed")).toBe("true");
  act(() => {
    vi.runAllTimers();
  });
  expect(latest()).toHaveLength(1);
  // Keyboard focus is retained immediately.
  const focusA = screen.getByRole("button", { name: "Focus to-do: Task A" });
  act(() => focusA.focus());
  expect(latest()).toHaveLength(1);
  expect(latest()).not.toEqual(alwaysRendered.at(-2));
});
