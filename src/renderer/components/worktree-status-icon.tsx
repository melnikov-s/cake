import type { WorktreeRecord } from "../../domain/managed-worktree-data";
import { cn } from "../lib/utils";
import { PullRequestIcon } from "./ui/icons";

interface WorktreeStatusIconProps {
  state: WorktreeRecord["state"];
  className?: string;
}

/** Presents the shared open/merged state treatment for a managed worktree. */
export function WorktreeStatusIcon({ state = "active", className }: WorktreeStatusIconProps) {
  const label =
    state === "landed" ? "Merged worktree" : state === "active" ? "Open worktree" : undefined;

  return (
    <span
      className={cn(
        state === "active" && "text-worktree-open",
        state === "landed" && "text-worktree-merged",
        className,
      )}
      data-worktree-state={state}
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
    >
      <PullRequestIcon />
    </span>
  );
}
