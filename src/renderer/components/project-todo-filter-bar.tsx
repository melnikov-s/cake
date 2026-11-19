import { observer } from "r-state-tree/react";
import type { ProjectTodoFilter, ProjectTodosStore } from "../stores/ProjectTodosStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

const FILTERS: ReadonlyArray<{
  readonly id: ProjectTodoFilter;
  readonly label: string;
  readonly countKey: "all" | "needsMe" | "running" | "idle";
}> = [
  { id: "all", label: "All", countKey: "all" },
  { id: "needs_me", label: "Needs me", countKey: "needsMe" },
  { id: "running", label: "Running", countKey: "running" },
  { id: "idle", label: "Idle", countKey: "idle" },
];

export const ProjectTodoFilterBar = observer(function ProjectTodoFilterBar({
  store,
}: {
  store: ProjectTodosStore;
}) {
  const counts = store.filterCounts;
  if (counts.all === 0 && store.filter === "all") return null;
  return (
    <div
      role="group"
      aria-label="Filter to-dos"
      className="flex flex-wrap items-center gap-1 px-3 pb-2"
    >
      {FILTERS.map((entry) => {
        const active = store.filter === entry.id;
        const count = counts[entry.countKey];
        return (
          <Button
            key={entry.id}
            variant={active ? "outline" : "ghost"}
            size="sm"
            aria-pressed={active}
            className={cn(
              "h-6 shrink-0 gap-1 rounded-md px-1.5 text-xs font-normal",
              active && "font-medium text-foreground",
            )}
            onClick={() => store.setFilter(entry.id)}
          >
            <span>{entry.label}</span>
            <span className="tabular-nums text-muted-foreground">{count}</span>
          </Button>
        );
      })}
    </div>
  );
});
