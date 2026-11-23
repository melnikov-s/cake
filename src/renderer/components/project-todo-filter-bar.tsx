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
      className="flex flex-wrap items-center gap-0.5 border-b border-hairline-subtle px-3 pb-2"
    >
      {FILTERS.map((entry) => {
        const active = store.filter === entry.id;
        const count = counts[entry.countKey];
        return (
          <Button
            key={entry.id}
            variant="ghost"
            size="sm"
            aria-pressed={active}
            className={cn(
              "h-6 shrink-0 gap-1 rounded-md border px-1.5 text-xs transition-colors",
              active
                ? "border-hairline bg-card font-semibold text-foreground shadow-2xs hover:bg-card"
                : "border-transparent font-normal text-muted-foreground hover:bg-foreground/[0.055] hover:text-foreground",
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
