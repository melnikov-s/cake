import type { CommitChangeStats } from "../../../contracts/worktrees/worktree-changes";
import { CommitIcon } from "./icons";

/** Quiet, shared committed-only metadata; unavailable/empty ranges add no chrome. */
export function CommitChangeStatsText({ stats }: { stats?: CommitChangeStats }) {
  if (!stats || stats.commitCount === 0) return null;
  return (
    <span
      data-slot="commit-change-stats"
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-normal tabular-nums [&>svg]:size-3"
      role="img"
      aria-label={`${stats.commitCount} ${stats.commitCount === 1 ? "commit" : "commits"}, +${stats.additions} −${stats.deletions}`}
      title="Committed changes since the session worktree base; binary line counts excluded"
    >
      <span>{stats.commitCount}</span>
      <CommitIcon />
      <span>
        +{stats.additions} −{stats.deletions}
      </span>
    </span>
  );
}
