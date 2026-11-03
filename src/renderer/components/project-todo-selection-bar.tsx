import { observer } from "r-state-tree/react";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { SelectionBar } from "./ui/selection-bar";

export const ProjectTodoSelectionBar = observer(function ProjectTodoSelectionBar({
  todos,
}: {
  todos: ProjectTodosStore;
}) {
  const selected = todos.selectedItem;
  if (!selected) return null;
  return (
    <SelectionBar
      label="Focused to-do:"
      title={selected.title}
      clearLabel="Clear to-do focus"
      disabled={todos.busy}
      onClear={() => void todos.clearSelection()}
    />
  );
});
