import { observer } from "r-state-tree/react";
import { Chip } from "@/components/ui/chip";
import { CheckIcon, CircleIcon } from "@/components/ui/icons";
import type { ProjectTodosStore, TodoResultOrigin } from "../stores/ProjectTodosStore";

/**
 * Marks the to-dos tracking a result message done in one click, through the same user
 * done/reopen path as the To-do pane. Renders nothing when no linked to-do is open.
 */
export const ResultTodoDone = observer(function ResultTodoDone({
  store,
  origin,
}: {
  store: ProjectTodosStore;
  origin: TodoResultOrigin;
}) {
  const items = store.itemsForResult(origin);
  if (!items.length) return null;
  return (
    <div
      role="group"
      aria-label="Linked to-dos"
      data-slot="result-todo-done"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {items.map((item) => {
        const done = item.state === "done";
        const label = `${done ? "Reopen to-do" : "Mark to-do done"}: ${item.title}`;
        return (
          <Chip
            key={item.id}
            active={done}
            disabled={store.busy}
            aria-label={label}
            title={label}
            icon={done ? <CheckIcon /> : <CircleIcon />}
            className="max-w-full [&_svg]:size-3"
            onClick={() => void store.setDone(item)}
          >
            <span>Done</span>
            <span className="min-w-0 truncate font-normal">{item.title}</span>
          </Chip>
        );
      })}
    </div>
  );
});
