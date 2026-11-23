import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodoActivitySummary } from "../stores/ProjectTodosStore";
import { cn } from "../lib/utils";
import { CheckIcon, MergeIcon } from "./ui/icons";
import { StatusDot } from "./ui/status-dot";

/** At-a-glance leading status indicator derived from item lifecycle and linked session activity. */
export function ProjectTodoStatusIndicator({
  item,
  summary,
  allowsCakeMerge = true,
  className,
}: {
  item: ProjectTodo;
  summary: ProjectTodoActivitySummary;
  allowsCakeMerge?: boolean;
  className?: string;
}) {
  const baseClassName = cn(
    "inline-flex size-4 shrink-0 items-center justify-center rounded-full",
    className,
  );
  if (item.state === "done") {
    return (
      <span
        role="img"
        aria-label="Done"
        title="Done"
        className={cn(baseClassName, "bg-success/15 text-success [&>svg]:size-2.5")}
      >
        <CheckIcon />
      </span>
    );
  }
  if (item.snoozedUntil) {
    return (
      <span role="img" aria-label="Snoozed" title="Snoozed" className={baseClassName}>
        <StatusDot status="stopped" />
      </span>
    );
  }
  if (item.needsAttention) {
    return (
      <span
        role="img"
        aria-label="Needs attention"
        title="Needs attention"
        className={cn(baseClassName, "bg-attention/15")}
      >
        <StatusDot status="attention" />
      </span>
    );
  }
  if (summary.mergeFailed || summary.error > 0) {
    const label = summary.mergeFailed ? "Merge failed" : "Error";
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(baseClassName, "bg-destructive/15")}
      >
        <StatusDot status="error" />
      </span>
    );
  }
  if (summary.readyToMerge) {
    const label = allowsCakeMerge ? "Ready to merge" : "Ready";
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(baseClassName, "bg-success/15 text-success [&>svg]:size-2.5")}
      >
        <MergeIcon />
      </span>
    );
  }
  if (summary.running > 0) {
    return (
      <span
        role="img"
        aria-label="Running"
        title="Running"
        className={cn(baseClassName, "bg-accent/15")}
      >
        <StatusDot status="running" />
      </span>
    );
  }
  if (summary.blocked > 0 || summary.waiting > 0) {
    const label = summary.blocked > 0 ? "Needs your input" : "Waiting for your answer";
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(baseClassName, "bg-attention/15")}
      >
        <StatusDot status="attention" />
      </span>
    );
  }
  return (
    <span role="img" aria-label="Open" title="Open" className={baseClassName}>
      <StatusDot status="stopped" className="border-[1.5px] border-muted-foreground/75" />
    </span>
  );
}
