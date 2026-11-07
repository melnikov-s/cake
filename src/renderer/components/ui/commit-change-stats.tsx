import type { CommitChangeStats } from "../../../contracts/worktrees/worktree-changes";

/** Quiet, shared committed-only metadata; unavailable/empty ranges add no chrome. */
export function CommitChangeStatsText({ stats }: { stats?: CommitChangeStats }) {
  if (!stats || stats.commitCount === 0) return null;
  return (
    <span
      data-slot="commit-change-stats"
      className="shrink-0 whitespace-nowrap text-xs font-normal tabular-nums"
      title="Committed changes since the session worktree base; binary line counts excluded"
    >
      {stats.commitCount} {stats.commitCount === 1 ? "commit" : "commits"} · +{stats.additions} −
      {stats.deletions}
    </span>
  );
}
