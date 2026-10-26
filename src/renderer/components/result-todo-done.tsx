import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CheckIcon, CircleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ProjectTodosStore, TodoResultOrigin } from "../stores/ProjectTodosStore";

export interface ResultTodoLink {
  origin?: TodoResultOrigin;
  todos?: ProjectTodosStore;
}

function linkedItems({ origin, todos }: ResultTodoLink) {
  return origin && todos ? todos.itemsForResult(origin) : [];
}

/**
 * Icon-only Done checkboxes for each to-do tracking a result message. Title and checked
 * state are read from the chat's live to-do list, the same items the To-do pane renders, so
 * a change from the pane, an agent tool or session resolution shows here at once. Toggling
 * goes through the pane's user done/reopen path. The tooltip names the to-do, because the
 * message title does not always say what is being resolved. Associations remain visible on
 * every matching incoming card, even when collapsed or followed by newer messages.
 */
export const ResultTodoDone = observer(function ResultTodoDone(link: ResultTodoLink) {
  const items = linkedItems(link);
  const todos = link.todos;
  if (!todos || !items.length) return null;
  return (
    <div
      role="group"
      aria-label="Linked to-dos"
      data-slot="result-todo-done"
      className="flex shrink-0 items-center gap-0.5"
    >
      {items.map((item) => {
        const done = item.state === "done";
        return (
          <IconButton
            key={item.id}
            role="checkbox"
            aria-checked={done}
            ariaLabel={`Done: ${item.title}`}
            tooltip={`${done ? "Reopen" : "Mark done"}: ${item.title}`}
            wrapTooltip
            disabled={todos.busy}
            className={cn(
              "[&_svg]:size-3.5",
              done && "bg-accent/15 text-accent hover:bg-accent/20 hover:text-accent",
            )}
            onClick={() => void todos.setDone(item)}
          >
            {done ? <CheckIcon /> : <CircleIcon />}
          </IconButton>
        );
      })}
    </div>
  );
});

/** The linked to-do titles, written out in an expanded result message's footer. */
export const ResultTodoTitles = observer(function ResultTodoTitles(link: ResultTodoLink) {
  const items = linkedItems(link);
  if (!items.length) return null;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      {items.map((item) => (
        <span key={item.id} className="min-w-0 break-words">
          To-do · {item.title}
        </span>
      ))}
    </div>
  );
});
