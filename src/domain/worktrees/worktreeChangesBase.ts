import { Effect } from "effect";
import { GitError } from "../../services/git/Git";

/** Trunk names lose fork-point ties: a feature branch at the same fork is the likelier parent. */
const defaultBranches = new Set(["main", "master"]);
const alternativeLimit = 10;
/** Reflogs are read only for the nearest candidates; the rest count as "creation unknown". */
const reflogLimit = 20;

interface Candidate {
  /** Full ref used in Git ranges, e.g. refs/remotes/origin/main. */
  readonly ref: string;
  /** Short display name, e.g. origin/main. */
  readonly name: string;
  readonly remote: boolean;
  readonly upstream: string;
  /** Commits on HEAD that this ref does not have: the fork point's distance from HEAD. */
  readonly distance: number;
  /** Commits on this ref since the fork. */
  readonly ahead: number;
}

interface InferredBase {
  readonly base: { readonly name: string; readonly ref: string } | null;
  readonly alternatives: readonly { readonly name: string; readonly distance: number }[];
}

const forEachRefFormat = "%(refname)%00%(refname:short)%00%(upstream)%00%(ahead-behind:HEAD)";

function parseRefs(output: string): Candidate[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", name = "", upstream = "", counts = ""] = line.split("\0");
      const [ahead = 0, distance = 0] = counts.split(" ").map(Number);
      return { ref, name, upstream, ahead, distance, remote: ref.startsWith("refs/remotes/") };
    });
}

const isTrunk = ({ name, remote }: Candidate) =>
  defaultBranches.has(remote ? name.slice(name.indexOf("/") + 1) : name);

/**
 * When Git first recorded each ref, from its oldest reflog entry. For the current branch, a later
 * rebase or reset counts instead: that is when it last chose what to grow from.
 */
function reflogTimes(walk: string, ownRef: string) {
  const times = new Map<string, number>();
  const resets = new Map<string, number>();
  for (const line of walk.split("\n")) {
    const [selector = "", subject = ""] = line.split("\0");
    const match = /^(refs\/.+)@\{(\d+)\}$/.exec(selector.trim());
    if (!match) continue;
    const [, ref = "", seconds = ""] = match;
    const time = Number(seconds);
    const previous = times.get(ref);
    // Entries arrive newest first, so the first rebase/reset seen for HEAD's branch is the latest.
    if (ref === ownRef && /^(rebase|reset)/.test(subject) && !resets.has(ref))
      resets.set(ref, time);
    times.set(ref, previous === undefined ? time : Math.min(previous, time));
  }
  return { times, ownSince: resets.get(ownRef) ?? times.get(ownRef) };
}

/**
 * Infers the ref HEAD forked from on every call; nothing is stored.
 * `%(ahead-behind:HEAD)` (Git 2.41+) counts every candidate in one graph walk, so huge
 * repositories pay for one process rather than one merge-base per branch.
 */
export const inferBase = Effect.fn("WorktreeChanges.inferBase")(function* (
  run: (args: readonly string[]) => Effect.Effect<string, GitError>,
  options: { readonly branch: string; readonly requested: string | undefined },
) {
  // The trunk has no parent branch; its review is the working tree alone.
  if (defaultBranches.has(options.branch))
    return { base: null, alternatives: [] } satisfies InferredBase;
  const forEachRef = (patterns: readonly string[]) =>
    run(["for-each-ref", `--format=${forEachRefFormat}`, ...patterns]).pipe(
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
  const ownRef = `refs/heads/${options.branch}`;
  const local = parseRefs(yield* forEachRef(["refs/heads"]));
  const own = local.find((candidate) => candidate.ref === ownRef);
  // Remote-tracking copies of other local branches (e.g. a fresher origin/main) are candidates;
  // this branch's own pushed copy is just an older HEAD, never a parent.
  const upstreams = [
    ...new Set(
      local
        .filter((candidate) => candidate.ref !== ownRef)
        .map((candidate) => candidate.upstream)
        .filter((ref) => ref.startsWith("refs/remotes/") && ref !== own?.upstream),
    ),
  ];
  const tracking = upstreams.length ? parseRefs(yield* forEachRef(upstreams)) : [];
  const candidates = [...local, ...tracking]
    .filter((candidate) => candidate.ref !== ownRef)
    .toSorted(
      (left, right) =>
        left.distance - right.distance ||
        Number(isTrunk(left)) - Number(isTrunk(right)) ||
        Number(left.remote) - Number(right.remote) ||
        left.ahead - right.ahead ||
        left.name.localeCompare(right.name),
    );
  const checked = candidates.slice(0, reflogLimit);
  const { times, ownSince } =
    checked.length && options.branch !== "HEAD"
      ? reflogTimes(
          yield* run([
            "log",
            "--walk-reflogs",
            "--date=unix",
            "--format=%gD%x00%gs",
            ownRef,
            ...checked.map((candidate) => candidate.ref),
            "--",
          ]),
          ownRef,
        )
      : { times: new Map<string, number>(), ownSince: undefined };
  const ranked = candidates.filter((candidate) => {
    const created = times.get(candidate.ref);
    // A ref that already contains HEAD is our parent only with proof it existed first (or it is
    // the trunk); otherwise it is a child of this branch. A brand-new child lands here: its
    // parent contains it, so it compares with the parent and shows no commits.
    if (candidate.distance === 0)
      return (
        isTrunk(candidate) ||
        (created !== undefined && ownSince !== undefined && created < ownSince)
      );
    // After two branches diverge the graph is symmetric: a parent that kept committing looks
    // like a fork of its own child. A ref first recorded after this branch cannot be its parent.
    return created === undefined || ownSince === undefined || created <= ownSince;
  });
  const chosen =
    ranked.find((candidate) => candidate.name === options.requested) ?? ranked[0] ?? null;
  const alternatives = ranked.slice(0, alternativeLimit);
  if (chosen && !alternatives.includes(chosen)) alternatives.push(chosen);
  return {
    base: chosen && { name: chosen.name, ref: chosen.ref },
    alternatives: alternatives.map(({ name, distance }) => ({ name, distance })),
  } satisfies InferredBase;
});
