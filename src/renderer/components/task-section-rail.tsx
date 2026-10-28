import { observer } from "r-state-tree/react";
import { MarginRail } from "./ui/margin-rail";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

export const TaskSectionRail = observer(function TaskSectionRail({
  todoId,
  start,
  todos,
}: {
  todoId: string;
  start: boolean;
  todos: ProjectTodosStore;
}) {
  const item = todos.value?.items.find((todo) => todo.id === todoId);
  if (!item) return null;
  return (
    <MarginRail
      title={item.title}
      status={item.status}
      done={item.state === "done"}
      start={start}
      onOpen={() => todos.reveal(item)}
    />
  );
});
