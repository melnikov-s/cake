import type { TranscriptItem } from "../components/chat-transcript-items";

/** Contiguous presentation sections, not a regrouped/reordered transcript. */
export function transcriptTaskSections(
  items: readonly TranscriptItem[],
  linkedTodo?: (item: TranscriptItem) => string | undefined,
) {
  let discussion: string | undefined;
  let current: string | undefined;
  let startIndex = 0;
  const sections = items.map((item, index) => {
    const previous = current;
    const linked = linkedTodo?.(item);
    const incoming =
      (item.kind === "text" &&
        Boolean(item.crossSession || item.subagentReport || item.agentSource)) ||
      (item.kind === "tool" && Boolean(item.messageReference));
    const human = item.kind === "text" && item.role === "user" && !incoming;
    if (human) {
      // Neither queued nor unresolved human input inherits the preceding task.
      discussion =
        item.deliveryState || item.taskAttributionPending
          ? undefined
          : item.taskTodoId === undefined
            ? linked
            : (item.taskTodoId ?? undefined);
    }
    if (item.kind === "skill") discussion = undefined;
    // A source card owns only its row, not the next conversational response.
    // Unknown/ambiguous sources interrupt the rail rather than borrowing its identity.
    current = !human && (incoming || linked) ? linked : discussion;
    if (current !== previous) startIndex = index;
    return { todoId: current, start: Boolean(current && current !== previous), startIndex };
  });
  return { sections };
}
