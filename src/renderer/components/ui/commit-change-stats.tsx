import type { CommitChangeStats } from "../../../contracts/worktrees/worktree-changes";
import { cn } from "@/lib/utils";
import { ChangeStats } from "./change-stats";
import { CommitIcon } from "./icons";

/**
 * Shared committed-only metadata: neutral commit count, colored line deltas; empty ranges add no chrome.
 * `compact` swaps the "commits" word for a leading icon where a row's line is already crowded.
 */
export function CommitChangeStatsText({
  stats,
  compact = false,
  className,
}: {
  stats?: CommitChangeStats;
  compact?: boolean;
  className?: string;
}) {
  if (!stats || stats.commitCount === 0) return null;
  const commits = `${stats.commitCount} ${stats.commitCount === 1 ? "commit" : "commits"}`;
  return (
    <span
      data-slot="commit-change-stats"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-normal tabular-nums",
        className,
      )}
      role="img"
      aria-label={`${commits}, +${stats.additions} −${stats.deletions}`}
      title="Outstanding committed changes against the landing target; binary line counts excluded"
    >
      {compact ? (
        <span className="inline-flex items-center gap-0.5 [&>svg]:size-3">
          <CommitIcon />
          {stats.commitCount}
        </span>
      ) : (
        <span>{commits}</span>
      )}
      <ChangeStats
        additions={stats.additions}
        deletions={stats.deletions}
        className="gap-1 font-sans"
      />
    </span>
  );
}
