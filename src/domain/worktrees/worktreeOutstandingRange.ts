import { Effect } from "effect";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import { Git } from "../../services/git/Git";

/** Resolve mutable refs on every observation; only immutable revision pairs may be cached. */
export const outstandingRange = Effect.fn("WorktreeChanges.outstandingRange")(function* (
  projectPath: string,
  source: string,
  target: string,
  landedSourceCommit?: WorktreeRecord["landedSourceCommit"],
) {
  const git = yield* Git;
  const run = (args: readonly string[]) => git.run(projectPath, args);
  const tip = (yield* run(["rev-parse", "--verify", `${source}^{commit}`])).trim();
  const targetTip = (yield* run(["rev-parse", "--verify", `${target}^{commit}`])).trim();
  let base = (yield* run(["merge-base", targetTip, tip])).trim();
  // Squash landing acknowledges source history without making it an ancestor of the target.
  // Only use a checkpoint on this source's ancestry, newer than the current merge-base.
  if (landedSourceCommit) {
    const checkpoint = (yield* run(["merge-base", landedSourceCommit, tip])).trim();
    const common = (yield* run(["merge-base", base, checkpoint])).trim();
    if (common === base) base = checkpoint;
  }
  return { base, tip, targetTip };
});
