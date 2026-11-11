import { observer } from "r-state-tree/react";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { CheckIcon, CircleIcon } from "./ui/icons";
import { IconSizeProvider } from "./ui/icon-size";
import { SelectionBar } from "./ui/selection-bar";
import { cn } from "@/lib/utils";

export const ProjectTodoSelectionBar = observer(function ProjectTodoSelectionBar({
  todos,
}: {
  todos: ProjectTodosStore;
}) {
  const focused = todos.focusedItems;
  if (focused.length === 0) return null;
  const done = focused.length === 1 && focused[0]!.state === "done";
  return (
    <SelectionBar
      label={focused.length === 1 ? "Focused to-do:" : "Focused to-dos:"}
      status={
        focused.length === 1 && (
          <span
            role="img"
            aria-label={done ? "Done" : "Open"}
            className={cn("flex shrink-0 text-muted-foreground", done && "text-success")}
          >
            <IconSizeProvider size="inline">
              {done ? <CheckIcon /> : <CircleIcon />}
            </IconSizeProvider>
          </span>
        )
      }
      title={focused.map((item) => item.title).join(", ")}
      clearLabel="Clear to-do focus"
      onClear={() => todos.clearFocus()}
    />
  );
});
