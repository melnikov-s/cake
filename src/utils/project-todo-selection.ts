import type { ProjectTodos } from "../contracts/projects/project-todos";

/** View focus never creates agent reminders or changes session lifecycle. */
export function clearProjectTodoSelection(value: ProjectTodos): ProjectTodos {
  const pending = value.pending.filter((entry) => entry._tag !== "Selection");
  if (value.selectedId === null && pending.length === value.pending.length) return value;
  return {
    ...value,
    selectedId: null,
    pending,
    deliveryToken: pending.length ? value.deliveryToken : null,
  };
}

/** Completion and snoozing clear view focus, not a composed reply attachment. */
export function clearCompletedProjectTodoSelection(value: ProjectTodos): ProjectTodos {
  return value.items.some(
    (item) => item.id === value.selectedId && item.state === "open" && !item.snoozedUntil,
  )
    ? value
    : clearProjectTodoSelection(value);
}
