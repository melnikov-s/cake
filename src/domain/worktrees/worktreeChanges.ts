import { Effect, FileSystem, Schema } from "effect";
import { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import { WorktreeChanges } from "../../contracts/worktrees/worktree-changes";
import { Git } from "../../services/git/Git";
import { parseNumstat } from "../../services/git/git-numstat";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";

/** Read-only review of the same branch range used by Managed Worktree landing. */
export const inspect = Effect.fn("WorktreeChanges.inspect")(
  function* (workspacePath: string) {
    if (!(yield* (yield* ProjectAccess).isAllowed(workspacePath)))
      return yield* new ManagedWorktreeError({
        operation: "changes",
        message: "Project path was not selected by the user",
      });
    const git = yield* Git;
    const run = (args: readonly string[]) => git.run(workspacePath, args);
    const status = yield* (yield* ManagedWorktrees).status(workspacePath);
    const record = status?.record;
    const branch = (yield* run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    // Ordinary checkouts use their configured upstream. Without one, there is no
    // separate branch baseline: do not invent a 'main' branch or count all history.
    const base =
      record?.baseBranch ??
      (yield* run(["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
        Effect.catchTag("GitError", () => Effect.succeed("HEAD")),
      )).trim();
    const revisions = record?.landedSourceCommit
      ? ["HEAD", `^${record.landedSourceCommit}`, `^${base}`]
      : [`${base}..HEAD`];
    const log = yield* run([
      "log",
      "--format=%x1e%H%x00%s%x00",
      "--diff-merges=first-parent",
      "--raw",
      "--numstat",
      "-z",
      "--no-renames",
      ...revisions,
      "--",
    ]);
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
      try: () => ({ staged: parseNumstat(stagedOutput), unstaged: parseNumstat(unstagedOutput) }),
      catch: (cause) => new ManagedWorktreeError({ operation: "changes", message: String(cause) }),
    });
    // Earlier commits may name a file deleted by a later commit. Preserve that
    // distinction from deletion *in* the listed commit for existing revision navigation.
    const paths = new Set(
      [...commits.flatMap((commit) => commit.files), ...tracked.staged, ...tracked.unstaged].map(
        (file) => file.path,
      ),
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
      base,
      commits: commits.map((commit) => ({ ...commit, files: withExistence(commit.files) })),
      staged: withExistence(tracked.staged),
      unstaged: [...withExistence(tracked.unstaged), ...untracked],
    });
  },
  Effect.mapError(
    (cause) =>
      new ManagedWorktreeError({
        operation: "changes",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  ),
);
