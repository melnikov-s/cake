import type { TranscriptItem } from "../components/chat-transcript-items";

/** Contiguous presentation sections, not a regrouped/reordered transcript. */
export function transcriptTaskSections(
  items: readonly TranscriptItem[],
  linkedTodo?: (item: TranscriptItem) => string | undefined,
) {
  let current: string | undefined;
  let startIndex = 0;
  const sections = items.map((item, index) => {
    const previous = current;
    const linked = linkedTodo?.(item);
    if (item.kind === "text" && item.role === "user") {
      // Neither queued nor unresolved human input inherits the preceding task.
      current =
        item.deliveryState || item.taskAttributionPending
          ? undefined
          : item.taskTodoId === undefined
            ? linked
            : (item.taskTodoId ?? undefined);
    } else if (linked) current = linked;
    if (item.kind === "skill") current = undefined;
    if (current !== previous) startIndex = index;
    return { todoId: current, start: Boolean(current && current !== previous), startIndex };
  });
  return { sections };
}
