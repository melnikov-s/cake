import type { ProjectTodos } from "../contracts/projects/project-todos";

/** Repair both live completions and old persisted selections without touching session lifecycle. */
export function clearCompletedProjectTodoSelection(
  value: ProjectTodos,
  newDeliveryToken: () => string,
): ProjectTodos {
  if (
    value.selectedId === null ||
    value.items.some((item) => item.id === value.selectedId && item.state === "open")
  )
    return value;
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
