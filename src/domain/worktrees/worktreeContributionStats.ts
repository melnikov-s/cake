import { Cache, Duration, Effect, Exit, Schema } from "effect";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import { ContributionStats, changeTotals } from "../../contracts/worktrees/worktree-changes";
import { Git } from "../../services/git/Git";
import { parseNumstat } from "../../services/git/git-numstat";
import { makeContributionRepository } from "../../services/worktrees/WorktreeContribution";

interface RevisionKey {
  readonly record: WorktreeRecord;
  readonly tip: string;
  readonly target: string;
  readonly checkpointRevision: string | undefined;
}

/** Cache immutable source/target/provenance revisions, never a mutable branch comparison. */
export const makeContributionStatsReader = Effect.fn("WorktreeCatalog.makeContributionStatsReader")(
  function* () {
    const git = yield* Git;
    const lookup = Effect.fn("WorktreeCatalog.contributionStats")(function* (key: RevisionKey) {
      const repository = makeContributionRepository(key.record.projectPath, git);
      const evidence = yield* repository.inspect(
        key.record,
        key.tip,
        key.target,
        key.checkpointRevision,
      );
      if (!evidence.baseline)
        return { additions: null, deletions: null, unavailableReason: evidence.unavailableReason };
      const output = yield* git.run(key.record.projectPath, [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        evidence.baseline,
        evidence.tip,
        "--",
      ]);
      const totals = yield* Effect.try(() => changeTotals(parseNumstat(output)));
      return yield* Schema.decodeUnknownEffect(ContributionStats)({
        additions: totals.additions,
        deletions: totals.deletions,
        unavailableReason: null,
      });
    });
    const cache = yield* Cache.makeWith(lookup, {
      capacity: 512,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.unavailableReason === null
          ? Duration.infinity
          : Duration.zero,
    });
    return Effect.fn("WorktreeCatalog.readContributionStats")(
      function* (record: WorktreeRecord) {
        const resolve = (ref: string) =>
          git
            .run(record.projectPath, ["rev-parse", "--verify", `${ref}^{commit}`])
            .pipe(Effect.map((value) => value.trim()));
        const repository = makeContributionRepository(record.projectPath, git);
        const tip = yield* repository.sourceTip(record);
        const target = yield* resolve(`refs/heads/${record.baseBranch}`);
        const checkpointRevision = record.contributionRef
          ? yield* resolve(record.contributionRef)
          : undefined;
        const key = { record, checkpointRevision, tip, target };
        // A pending checkpoint also depends on live rebase/abort state, not just revision IDs.
        if (checkpointRevision && (yield* repository.hasPending(checkpointRevision)))
          return yield* lookup(key);
        return yield* Cache.get(cache, key);
      },
      Effect.catch((error) =>
        Effect.succeed({
          additions: null,
          deletions: null,
          unavailableReason: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  },
);
