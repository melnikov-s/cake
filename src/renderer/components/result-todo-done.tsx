import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { CheckIcon, CircleIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { UiPart } from "../../contracts/conversations/session-contract";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { resultTodoOrigin } from "../lib/result-todo-origin";

/**
 * A footer bar inside a result message for each to-do tracking it: "To-do · title" with a
 * one-click Done, through the same user done/reopen path as the To-do pane. Renders nothing
 * unless the message is a result linked to an open (or user-closed) to-do.
 */
export const ResultTodoFooter = observer(function ResultTodoFooter({
  part,
  todos,
  chatSessionId,
  className,
}: {
  part: UiPart;
  todos?: ProjectTodosStore;
  chatSessionId?: string;
  /** Aligns the bar with the host message's own horizontal padding. */
  className?: string;
}) {
  const origin = todos?.available ? resultTodoOrigin(part, chatSessionId) : undefined;
  const items = origin && todos ? todos.itemsForResult(origin) : [];
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
        const label = `${done ? "Reopen to-do" : "Mark to-do done"}: ${item.title}`;
        return (
          <div key={item.id} className="flex min-w-0 items-center gap-3 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.title}>
              To-do · {item.title}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={label}
              aria-pressed={done}
              title={label}
              disabled={todos.busy}
              className={cn(
                "h-7 shrink-0 gap-1.5 px-2 font-medium [&_svg]:size-3.5",
                done &&
                  "bg-accent/15 font-semibold text-accent hover:bg-accent/20 hover:text-accent",
              )}
              onClick={() => void todos.setDone(item)}
            >
              {done ? <CheckIcon /> : <CircleIcon />}
              {done ? "Done" : "Mark done"}
            </Button>
          </div>
        );
      })}
    </div>
  );
});
