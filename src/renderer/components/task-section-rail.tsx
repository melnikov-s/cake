import { observer } from "r-state-tree/react";
import { LabelPicker } from "./ui/label-picker";
import { MarginRail } from "./ui/margin-rail";
import { ProjectTodoStateAction } from "./project-todo-state-action";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

export const TaskSectionRail = observer(function TaskSectionRail({
  todoId,
  start,
  todos,
  expanded,
  onToggle,
  headingOnly = false,
  editable = false,
}: {
  todoId: string;
  start: boolean;
  todos: ProjectTodosStore;
  expanded: boolean;
  onToggle?(): void;
  headingOnly?: boolean;
  editable?: boolean;
}) {
  const item = todos.value?.items.find((todo) => todo.id === todoId);
  if (!item) return null;
  return (
    <MarginRail
      showRail={!headingOnly}
      title={item.title}
      label={
        start && (
          <LabelPicker
            labelId={item.labelId}
            labels={todos.availableLabels(item)}
            ariaLabel={`Change label for ${item.title}`}
            disabled={todos.busy || !editable}
            className="-ml-0.5 size-6"
            onChange={(labelId) => todos.setLabel(item, labelId, { notifyOnError: true })}
          />
        )
      }
      completion={
        start &&
        editable && (
          <ProjectTodoStateAction
            item={item}
            title={item.title}
            done={item.state === "done"}
            store={todos}
            notifyOnError
            className="opacity-0 disabled:opacity-0 group-hover/task-heading:opacity-100 group-hover/task-heading:disabled:opacity-30 group-has-[:focus-visible]/task-heading:opacity-100 group-has-[:focus-visible]/task-heading:disabled:opacity-30 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:disabled:opacity-30"
          />
        )
      }
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
