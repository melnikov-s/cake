import { observer } from "r-state-tree/react";
import { MarginRail } from "./ui/margin-rail";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

export const TaskSectionRail = observer(function TaskSectionRail({
  todoId,
  start,
  todos,
  expanded,
  onToggle,
  headingOnly = false,
}: {
  todoId: string;
  start: boolean;
  todos: ProjectTodosStore;
  expanded: boolean;
  onToggle?(): void;
  headingOnly?: boolean;
}) {
  const item = todos.value?.items.find((todo) => todo.id === todoId);
  if (!item) return null;
  return (
    <MarginRail
      showRail={!headingOnly}
      title={item.title}
      done={item.state === "done"}
      start={start}
      onOpen={() => todos.reveal(item)}
      onFocus={() => {
        todos.open();
        todos.toggleFocus(item);
      }}
      expanded={expanded}
      onToggle={onToggle}
    />
  );
});
