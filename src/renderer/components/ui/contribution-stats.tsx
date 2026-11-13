import type { ContributionStats } from "../../../contracts/worktrees/worktree-changes";
import { cn } from "@/lib/utils";
import { ChangeStats } from "./change-stats";

/** Shared committed contribution; historical commit counts and uncommitted edits stay separate. */
export function ContributionStatsText({
  stats,
  className,
}: {
  stats?: ContributionStats;
  className?: string;
}) {
  if (!stats) return null;
  const unavailable = stats.unavailableReason !== null;
  if (!unavailable && stats.additions === 0 && stats.deletions === 0) return null;
  return (
    <span
      data-slot="contribution-stats"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-normal tabular-nums",
        className,
      )}
      role="img"
      aria-label={
        unavailable
          ? "Contribution unavailable"
          : `Contribution: +${stats.additions} −${stats.deletions}`
      }
      title={
        stats.unavailableReason ??
        "This worktree's net committed contribution; uncommitted edits and binary line counts excluded"
      }
    >
      {unavailable ? (
        "Contribution unavailable"
      ) : (
        <ChangeStats
          additions={stats.additions}
          deletions={stats.deletions}
          className="gap-1 font-sans"
        />
      )}
    </span>
  );
}
