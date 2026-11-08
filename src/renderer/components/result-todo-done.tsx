import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { CheckIcon, CircleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ProjectTodosStore, TodoResultOrigin } from "../stores/ProjectTodosStore";

export interface ResultTodoLink {
  origin?: TodoResultOrigin;
  todos?: ProjectTodosStore;
}

/**
 * Each linked to-do owns its title and done/reopen action in the result footer.
 * Read the same live items as the To-do pane and use its user mutation path.
 */
export const ResultTodoDone = observer(function ResultTodoDone({ origin, todos }: ResultTodoLink) {
  const items = origin && todos ? todos.itemsForResult(origin) : [];
  if (!todos || !items.length) return null;
  return (
    <div
      role="group"
      aria-label="Linked to-dos"
      data-slot="result-todo-done"
      className="flex min-w-0 flex-1 flex-col gap-2"
    >
      {items.map((item) => {
        const done = item.state === "done";
        const action = done ? "Reopen" : "Mark done";
        return (
          <div
            key={item.id}
            data-slot="result-todo-entry"
            className="flex min-w-0 flex-col gap-0.5"
          >
            <span className="min-w-0 break-words">To-do · {item.title}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${action}: ${item.title}`}
              title={`${action}: ${item.title}`}
              disabled={todos.busy}
              className={cn(
                "gap-1.5 self-start [&_svg]:size-3.5",
                done && "bg-accent/15 text-accent hover:bg-accent/20 hover:text-accent",
              )}
              onClick={() => void todos.setDone(item)}
            >
              {done ? <CheckIcon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
              {action}
            </Button>
          </div>
        );
      })}
    </div>
  );
});
