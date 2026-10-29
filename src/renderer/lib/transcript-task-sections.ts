import type { TranscriptItem } from "../components/chat-transcript-items";

/** Contiguous presentation sections, not a regrouped/reordered transcript. */
export function transcriptTaskSections(
  items: readonly TranscriptItem[],
  linkedTodo?: (item: TranscriptItem) => string | undefined,
) {
  let current: string | undefined;
  const sections = items.map((item) => {
    const previous = current;
    const linked = linkedTodo?.(item);
    if (item.kind === "text" && item.role === "user" && !item.deliveryState) {
      // Pending is provisional continuity, not a topic decision. Settled null
      // (including reported attribution failures) still ends the section.
      if (!item.taskAttributionPending)
        current = item.taskTodoId === undefined ? linked : (item.taskTodoId ?? undefined);
    } else if (linked) current = linked;
    if (item.kind === "skill") current = undefined;
    return { todoId: current, start: Boolean(current && current !== previous) };
  });
  return { sections };
}
