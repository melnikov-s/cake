import { Effect, FileSystem, Schema } from "effect";
import { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import { WorktreeChanges, commitListLimit } from "../../contracts/worktrees/worktree-changes";
import { Git, GitError } from "../../services/git/Git";
import { parseNumstat } from "../../services/git/git-numstat";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { inferBase } from "./worktreeChangesBase";
import { makeContributionRepository } from "../../services/worktrees/WorktreeContribution";
import { outstandingRange } from "./worktreeOutstandingRange";

/**
 * Contribution review plus separate unlanded commit history and uncommitted edits.
 * Parent inference alone is never treated as durable contribution evidence.
 */
export const inspect = Effect.fn("WorktreeChanges.inspect")(
  function* (workspacePath: string, options: { readonly base?: string | undefined }) {
    if (!(yield* (yield* ProjectAccess).isAllowed(workspacePath)))
      return yield* new ManagedWorktreeError({
        operation: "changes",
        message: "Project path was not selected by the user",
      });
    const git = yield* Git;
    const run = (args: readonly string[]) => git.run(workspacePath, args);
    const status = yield* (yield* ManagedWorktrees).status(workspacePath);
    const branch = (yield* run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const record = status?.record;
    const inferred = record
      ? {
          base: { name: record.baseBranch, ref: `refs/heads/${record.baseBranch}` },
          alternatives: [],
        }
      : yield* inferBase(run, { branch, requested: options.base });
    const base = inferred.base?.ref;
    const range = base
      ? yield* outstandingRange(workspacePath, "HEAD", base, record?.landedSourceCommit)
      : null;
    const headRevision = range?.tip ?? (yield* run(["rev-parse", "HEAD"])).trim();
    const contribution = record
      ? yield* makeContributionRepository(workspacePath, git).inspect(record, headRevision)
      : {
          baseline: null,
          tip: headRevision,
          unavailableReason: "This checkout has no recorded worktree creation baseline",
        };
    const revisions = range ? [range.tip, `^${range.targetTip}`, `^${range.base}`] : [];
    const filesOutput = contribution.baseline
      ? yield* run([
          "diff",
          "--raw",
          "--numstat",
          "-z",
          "--no-renames",
          contribution.baseline,
          contribution.tip,
          "--",
        ])
      : "";
    const totalCommits = base
      ? Number((yield* run(["rev-list", "--count", ...revisions, "--"])).trim())
      : 0;
    const log = base
      ? yield* run([
          "log",
          `--max-count=${commitListLimit}`,
          "--format=%x1e%H%x00%s%x00",
          "--diff-merges=first-parent",
          "--raw",
          "--numstat",
          "-z",
          "--no-renames",
          ...revisions,
          "--",
        ])
      : "";
    const commits = yield* Effect.try({
      try: () =>
        log
          .split("\x1e")
          .filter(Boolean)
          .map((entry) => {
            const [hash = "", subject = "", ...stats] = entry.split("\0");
            return { hash, subject, files: parseNumstat(stats.join("\0")) };
          }),
      catch: (cause) => new ManagedWorktreeError({ operation: "changes", message: String(cause) }),
    });
    const stagedOutput = yield* run([
      "diff",
      "--cached",
      "--raw",
      "--numstat",
      "-z",
      "--no-renames",
      "--",
    ]);
    const unstagedOutput = yield* run(["diff", "--raw", "--numstat", "-z", "--no-renames", "--"]);
    const untrackedPaths = (yield* run(["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);
    const fs = yield* FileSystem.FileSystem;
    const untracked = yield* Effect.forEach(untrackedPaths, (path) =>
      fs.readFile(`${workspacePath}/${path}`).pipe(
        Effect.map((bytes) => {
          // Git's default binary heuristic scans the first 8000 bytes for NUL.
          const binary = bytes.subarray(0, 8000).includes(0);
          let lines = 0;
          for (const byte of bytes) if (byte === 10) lines++;
          if (bytes.length > 0 && bytes.at(-1) !== 10) lines++;
          return {
            path,
            deleted: false,
            workingTreeExists: true,
            additions: binary ? null : lines,
            deletions: binary ? null : 0,
          };
        }),
      ),
    );
    const tracked = yield* Effect.try({
      try: () => ({
        files: parseNumstat(filesOutput),
        staged: parseNumstat(stagedOutput),
        unstaged: parseNumstat(unstagedOutput),
      }),
      catch: (cause) => new ManagedWorktreeError({ operation: "changes", message: String(cause) }),
    });
    // Earlier commits may name a file deleted by a later commit. Preserve that
    // distinction from deletion *in* the listed commit for existing revision navigation.
    const paths = new Set(
      [
        ...tracked.files,
        ...commits.flatMap((commit) => commit.files),
        ...tracked.staged,
        ...tracked.unstaged,
      ].map((file) => file.path),
    );
    const existence = new Map(
      yield* Effect.forEach([...paths], (path) =>
        fs.exists(`${workspacePath}/${path}`).pipe(Effect.map((exists) => [path, exists] as const)),
      ),
    );
    const withExistence = (files: ReturnType<typeof parseNumstat>) =>
      files.map((file) => ({
        ...file,
        workingTreeExists: existence.get(file.path) === true,
      }));
    return yield* Schema.decodeUnknownEffect(WorktreeChanges)({
      branch,
      base: inferred.base?.name ?? null,
      baseAlternatives: inferred.alternatives.map(({ name, distance }) => ({
        branch: name,
        distance,
      })),
      baseRevision: contribution.baseline,
      headRevision,
      contributionUnavailableReason: contribution.unavailableReason,
      files: withExistence(tracked.files),
      commits: commits.map((commit) => ({ ...commit, files: withExistence(commit.files) })),
      totalCommits,
      staged: withExistence(tracked.staged),
      unstaged: [...withExistence(tracked.unstaged), ...untracked],
    });
  },
  Effect.mapError(
    (cause) =>
      new ManagedWorktreeError({
        operation: "changes",
        message:
          cause instanceof GitError
            ? `${cause.operation.split(" ").slice(0, 2).join(" ")} failed: ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause),
      }),
  ),
  (effect, workspacePath) =>
    Effect.tapError(effect, (error) =>
      Effect.logWarning("Worktree changes failed", { workspacePath, message: error.message }),
    ),
);
