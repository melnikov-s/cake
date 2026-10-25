import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { CheckIcon, CircleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ProjectTodosStore, TodoResultOrigin } from "../stores/ProjectTodosStore";

/**
 * A footer bar inside a result message for each to-do tracking it: "To-do · title" with a Done
 * checkbox. Title and checked state are read from the chat's live to-do list, the same items
 * the To-do pane renders, so a change from the pane, an agent tool or session resolution shows
 * here at once. Toggling goes through the pane's user done/reopen path. Associations remain
 * visible on every matching incoming card, even when collapsed or followed by newer messages.
 */
export const ResultTodoFooter = observer(function ResultTodoFooter({
  origin,
  todos,
}: {
  origin?: TodoResultOrigin;
  todos?: ProjectTodosStore;
}) {
  const items = origin ? (todos?.itemsForResult(origin) ?? []) : [];
  if (!todos || !items.length) return null;
  return (
    <div
      role="group"
      aria-label="Linked to-dos"
      data-slot="result-todo-done"
      className="mx-5 mt-3 mb-1 border-t border-border/60 pt-2"
    >
      {items.map((item) => {
        const done = item.state === "done";
        return (
          <div key={item.id} className="flex min-w-0 items-center gap-3 text-xs">
            <span className="min-w-0 flex-1 break-words text-muted-foreground" title={item.title}>
              To-do · {item.title}
            </span>
            <Button
              variant="ghost"
              size="sm"
              role="checkbox"
              aria-checked={done}
              aria-label={`Done: ${item.title}`}
              title={`${done ? "Reopen" : "Mark done"}: ${item.title}`}
              disabled={todos.busy}
              className={cn(
                "h-7 shrink-0 gap-1.5 px-2 font-medium [&_svg]:size-3.5",
                done &&
                  "bg-accent/15 font-semibold text-accent hover:bg-accent/20 hover:text-accent",
              )}
              onClick={() => void todos.setDone(item)}
            >
              {done ? <CheckIcon /> : <CircleIcon />}
              Done
            </Button>
          </div>
        );
      })}
    </div>
  );
});
