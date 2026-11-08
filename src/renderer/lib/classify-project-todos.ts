import { projectTodoCategory, type ProjectTodo } from "../../contracts/projects/project-todos";

interface OrderedTodo {
  item: ProjectTodo;
  index: number;
}

const newestFirst = (a: OrderedTodo, b: OrderedTodo) => {
  const byCreation = (b.item.createdAt ?? "").localeCompare(a.item.createdAt ?? "");
  if (byCreation) return byCreation;
  // Legacy lists appended new items and retained positions on edit.
  if (!a.item.createdAt && !b.item.createdAt) return b.index - a.index;
  return a.item.id.localeCompare(b.item.id);
};

/** One storage-order pass; lookups live only for this calculation. */
export function classifyProjectTodos(
  items: readonly ProjectTodo[],
  focusedItemIds: readonly string[],
  query: string,
  isReadyToMerge: (item: ProjectTodo) => boolean,
) {
  const focusedIds = new Set(focusedItemIds);
  const focused = new Map<string, ProjectTodo>();
  const attention: ProjectTodo[] = [];
  const ready: OrderedTodo[] = [];
  const active: OrderedTodo[] = [];
  const snoozed: OrderedTodo[] = [];
  const done: OrderedTodo[] = [];
  const search = query.trim().toLowerCase();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const category = projectTodoCategory(item);
    if (
      search &&
      !item.title.toLowerCase().includes(search) &&
      !item.description.toLowerCase().includes(search) &&
      !(category === "attention" && item.attentionReason?.toLowerCase().includes(search))
    )
      continue;
    if (focusedIds.has(item.id)) {
      focused.set(item.id, item);
      continue;
    }
    if (category === "attention") attention.push(item);
    else if (category === "done") done.push({ item, index });
    else if (category === "snoozed") snoozed.push({ item, index });
    else (isReadyToMerge(item) ? ready : active).push({ item, index });
  }
  return {
    focused: focusedItemIds.flatMap((id) => focused.get(id) ?? []),
    // Stable sort preserves storage order for legacy/equal sequences.
    attention: attention.sort((a, b) => (a.attentionSequence ?? 0) - (b.attentionSequence ?? 0)),
    ready: ready.sort(newestFirst).map(({ item }) => item),
    active: active.sort(newestFirst).map(({ item }) => item),
    snoozed: snoozed.sort(newestFirst).map(({ item }) => item),
    done: done.sort(newestFirst).map(({ item }) => item),
  };
}
