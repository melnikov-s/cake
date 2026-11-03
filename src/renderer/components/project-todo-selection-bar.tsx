import { observer } from "r-state-tree/react";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { SelectionBar } from "./ui/selection-bar";

export const ProjectTodoSelectionBar = observer(function ProjectTodoSelectionBar({
  todos,
}: {
  todos: ProjectTodosStore;
}) {
  const focused = todos.focusedItems;
  if (focused.length === 0) return null;
  return (
    <SelectionBar
      label={focused.length === 1 ? "Focused to-do:" : "Focused to-dos:"}
      title={focused.map((item) => item.title).join(", ")}
      clearLabel="Clear to-do focus"
      onClear={() => todos.clearFocus()}
    />
  );
});
