import { Effect } from "effect";
import { GitError } from "../../services/git/Git";

/** Trunk names lose fork-point ties: a feature branch at the same fork is the likelier parent. */
const defaultBranches = new Set(["main", "master"]);
const alternativeLimit = 10;

interface BaseCandidate {
  readonly branch: string;
  /** Commits on HEAD that this branch does not have: the fork point's distance from HEAD. */
  readonly distance: number;
  /** Commits on this branch since the fork. */
  readonly ahead: number;
}

interface InferredBase {
  readonly base: string | null;
  readonly alternatives: readonly BaseCandidate[];
  readonly note: string | undefined;
}

/**
 * Orders possible parents by the Git graph alone. Branches that already contain HEAD
 * (behind = 0) are children or copies of this branch, never its parent.
 */
function rankCandidates(forEachRef: string, currentBranch: string): readonly BaseCandidate[] {
  return forEachRef
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [branch = "", counts = ""] = line.split("\0");
      const [ahead = 0, distance = 0] = counts.split(" ").map(Number);
      return { branch, ahead, distance };
    })
    .filter(({ branch, distance }) => branch && branch !== currentBranch && distance > 0)
    .toSorted(
      (left, right) =>
        left.distance - right.distance ||
        Number(defaultBranches.has(left.branch)) - Number(defaultBranches.has(right.branch)) ||
        left.ahead - right.ahead ||
        left.branch.localeCompare(right.branch),
    );
}

/** Oldest reflog entry per branch: when Git first recorded it. Expired reflogs are unknown. */
function creationTimes(walk: string) {
  const times = new Map<string, number>();
  for (const line of walk.split("\n")) {
    const match = /^refs\/heads\/(.+)@\{(\d+)\}$/.exec(line.trim());
    if (!match) continue;
    const [, branch = "", seconds = ""] = match;
    times.set(branch, Math.min(Number(seconds), times.get(branch) ?? Infinity));
  }
  return times;
}

/**
 * Infers the branch HEAD forked from on every call; nothing is stored.
 * `%(ahead-behind:HEAD)` (Git 2.41+) counts every local branch in one graph walk, so
 * huge repositories pay for a single process rather than one merge-base per branch.
 */
export const inferBase = Effect.fn("WorktreeChanges.inferBase")(function* (
  run: (args: readonly string[]) => Effect.Effect<string, GitError>,
  options: { readonly branch: string; readonly requested?: string; readonly previous?: string },
) {
  // The trunk has no parent branch; its review is the working tree alone.
  if (defaultBranches.has(options.branch))
    return { base: null, alternatives: [], note: undefined } satisfies InferredBase;
  const refs = yield* run([
    "for-each-ref",
    "--format=%(refname:lstrip=2)%00%(ahead-behind:HEAD)",
    "refs/heads",
  ]).pipe(
    Effect.mapError((error) =>
      error.message.includes("ahead-behind")
        ? new GitError({
            operation: error.operation,
            workingDirectory: error.workingDirectory,
            message: "Finding the parent branch requires Git 2.41 or newer",
          })
        : error,
    ),
  );
  const existing = new Set(refs.split("\n").map((line) => line.split("\0")[0]));
  const graphRanked = rankCandidates(refs, options.branch);
  // After two branches diverge the graph is symmetric: a parent that kept committing looks
  // like a fork of its own child. Branch creation times in Git's reflog break the tie.
  const created =
    graphRanked.length && options.branch !== "HEAD"
      ? creationTimes(
          yield* run([
            "log",
            "--walk-reflogs",
            "--date=unix",
            "--format=%gD",
            ...[options.branch, ...graphRanked.slice(0, alternativeLimit).map((c) => c.branch)].map(
              (branch) => `refs/heads/${branch}`,
            ),
            "--",
          ]),
        )
      : new Map<string, number>();
  const ownCreation = created.get(options.branch);
  const ranked = graphRanked.filter(({ branch }) => {
    const creation = created.get(branch);
    return ownCreation === undefined || creation === undefined || creation <= ownCreation;
  });
  const missing = [options.requested, options.previous].find(
    (name) => name !== undefined && !existing.has(name),
  );
  const requested =
    options.requested && existing.has(options.requested) && options.requested !== options.branch
      ? options.requested
      : undefined;
  const base = requested ?? ranked[0]?.branch ?? null;
  const alternatives = ranked.slice(0, alternativeLimit);
  const chosen = ranked.find((candidate) => candidate.branch === base);
  if (chosen && !alternatives.includes(chosen)) alternatives.push(chosen);
  return {
    base,
    alternatives,
    note: missing && missing !== base ? `${missing} no longer exists` : undefined,
  } satisfies InferredBase;
});
