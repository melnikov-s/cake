import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { CheckIcon, CircleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

/**
 * A footer bar inside a result message for each to-do tracking it: "To-do · title" with a Done
 * checkbox. Title and checked state are read from the chat's live to-do list, the same items
 * the To-do pane renders, so a change from the pane, an agent tool or session resolution shows
 * here at once. Toggling goes through the pane's user done/reopen path. Renders nothing unless
 * this is the latest result linked to a to-do that is still in the list.
 */
export const ResultTodoFooter = observer(function ResultTodoFooter({
  partId,
  todos,
  className,
}: {
  partId: string;
  todos?: ProjectTodosStore;
  /** Aligns the bar with the host message's own horizontal padding. */
  className?: string;
}) {
  const items = todos?.itemsForPart(partId) ?? [];
  if (!todos || !items.length) return null;
  return (
    <div
      role="group"
      aria-label="Linked to-dos"
      data-slot="result-todo-done"
      className={cn("mt-3 border-t border-border/60 pt-2", className)}
    >
      {items.map((item) => {
        const done = item.state === "done";
        return (
          <div key={item.id} className="flex min-w-0 items-center gap-3 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.title}>
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
