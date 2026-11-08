import { Cache, Duration, Effect, Exit, Schema } from "effect";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import { CommitChangeStats, changeTotals } from "../../contracts/worktrees/worktree-changes";
import { Git } from "../../services/git/Git";
import { parseNumstat } from "../../services/git/git-numstat";
import { outstandingRange } from "./worktreeOutstandingRange";

interface RevisionKey {
  readonly projectPath: string;
  readonly base: string;
  readonly tip: string;
  readonly targetTip: string;
}

/** Observation-owned, bounded cache of immutable revision triples; no render-time Git work. */
export const makeCommitStatsReader = Effect.fn("WorktreeCatalog.makeCommitStatsReader")(
  function* () {
    const git = yield* Git;
    const cache = yield* Cache.makeWith(
      Effect.fn("WorktreeCatalog.commitStats")(function* (key: RevisionKey) {
        const rawCount = yield* git.run(key.projectPath, [
          "rev-list",
          "--count",
          key.tip,
          `^${key.targetTip}`,
          `^${key.base}`,
          "--",
        ]);
        const commitCount = Number(
          yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^\d+$/)))(
            rawCount.trim(),
          ),
        );
        const output = yield* git.run(key.projectPath, [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          key.base,
          key.tip,
          "--",
        ]);
        const totals = yield* Effect.try(() => changeTotals(parseNumstat(output)));
        return yield* Schema.decodeUnknownEffect(CommitChangeStats)({
          commitCount,
          additions: totals.additions,
          deletions: totals.deletions,
        });
      }),
      {
        capacity: 512,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );
    return Effect.fn("WorktreeCatalog.readCommitStats")(
      function* (record: WorktreeRecord) {
        const { base, tip, targetTip } = yield* outstandingRange(
          record.projectPath,
          `refs/heads/${record.branch}`,
          `refs/heads/${record.baseBranch}`,
          record.landedSourceCommit,
        ).pipe(Effect.provideService(Git, git));
        return yield* Cache.get(cache, {
          projectPath: record.projectPath,
          base,
          tip,
          targetTip,
        });
      },
      Effect.catch(() => Effect.succeed(undefined)),
    );
  },
);
