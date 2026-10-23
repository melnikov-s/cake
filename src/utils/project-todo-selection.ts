import type { ProjectTodos } from "../contracts/projects/project-todos";

/** Clear the selection and tell the agent it changed, without touching session lifecycle. */
export function clearProjectTodoSelection(
  value: ProjectTodos,
  newDeliveryToken: () => string,
): ProjectTodos {
  if (value.selectedId === null) return value;
  const sequence = value.sequence + 1;
  return {
    ...value,
    selectedId: null,
    sequence,
    deliveryToken: newDeliveryToken(),
    pending: [
      ...value.pending.filter((entry) => entry._tag !== "Selection"),
      { _tag: "Selection", selectedId: null, sequence },
    ],
  };
}

/** A completed to-do can no longer be selected. */
export function clearCompletedProjectTodoSelection(
  value: ProjectTodos,
  newDeliveryToken: () => string,
): ProjectTodos {
  return value.items.some((item) => item.id === value.selectedId && item.state === "open")
    ? value
    : clearProjectTodoSelection(value, newDeliveryToken);
}
