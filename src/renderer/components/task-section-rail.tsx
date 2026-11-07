import { observer } from "r-state-tree/react";
import { MarginRail } from "./ui/margin-rail";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

export const TaskSectionRail = observer(function TaskSectionRail({
  todoId,
  start,
  todos,
  expanded,
  onToggle,
}: {
  todoId: string;
  start: boolean;
  todos: ProjectTodosStore;
  expanded: boolean;
  onToggle(): void;
}) {
  const item = todos.value?.items.find((todo) => todo.id === todoId);
  if (!item) return null;
  return (
    <MarginRail
      title={item.title}
      done={item.state === "done"}
      start={start}
      onOpen={() => todos.reveal(item)}
      onFocus={() => {
        todos.open();
        todos.toggleFocus(item);
      }}
      focused={todos.isFocused(item.id)}
      expanded={expanded}
      onToggle={onToggle}
    />
  );
});
