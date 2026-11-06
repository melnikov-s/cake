import { Cache, Duration, Effect, Exit, FileSystem, Path, Ref, Semaphore } from "effect";
import { Git } from "../git/Git";

const internalError = (message: string) => Effect.fail(new Error(message));
const resolveNormalized = (path: string) => path.replace(/\/+$/, "");

/** Native Git facts and the mutation locks shared by checkout and landing operations. */
export const makeWorktreeRepository = Effect.fn("ManagedWorktrees.makeRepository")(function* () {
  const gitService = yield* Git;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
  const worktreeLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
  const exists = (target: string) => fileSystem.exists(target);
  const git = Effect.fn("ManagedWorktrees.git")((cwd: string, ...args: ReadonlyArray<string>) =>
    gitService.run(cwd, args),
  );
  // GitRunner only acknowledges Promise settlement, so defer interruption for mutations until
  // settlement. Reads and repository-lock acquisition remain interruptible.
  const gitMutation = Effect.fn("ManagedWorktrees.gitMutation")(
    (cwd: string, ...args: ReadonlyArray<string>) => git(cwd, ...args).pipe(Effect.uninterruptible),
  );
  const gitOptional = Effect.fn("ManagedWorktrees.gitOptional")(
    (cwd: string, args: ReadonlyArray<string>) =>
      git(cwd, ...args).pipe(
        Effect.map((value) => value.trim()),
        Effect.option,
      ),
  );
  const keyedLock =
    (registry: Ref.Ref<Map<string, Semaphore.Semaphore>>) =>
    <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
      Ref.modify(registry, (locks) => {
        const current = locks.get(key);
        if (current) return [current, locks] as const;
        const created = Semaphore.makeUnsafe(1);
        const next = new Map(locks);
        next.set(key, created);
        return [created, next] as const;
      }).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));
  const repositoryLock = keyedLock(repositoryLocks);
  /** Always taken before, never inside, a repository lock. */
  const withWorktreeLock = <A, E, R>(worktreePath: string, effect: Effect.Effect<A, E, R>) =>
    keyedLock(worktreeLocks)(resolveNormalized(worktreePath), effect);
  const repositoryRoot = Effect.fn("ManagedWorktrees.repositoryRoot")(function* (
    projectPath: string,
  ) {
    return yield* git(projectPath, "rev-parse", "--show-toplevel").pipe(
      Effect.map((value) => value.trim()),
      Effect.catch(() => internalError("Worktrees require a Git repository")),
    );
  });
  const repositoryIdentityCache = yield* Cache.makeWith(
    Effect.fn("ManagedWorktrees.resolveRepositoryIdentity")(function* (workingDirectory: string) {
      const commonDirectory = (yield* git(
        workingDirectory,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      )).trim();
      return yield* fileSystem.realPath(commonDirectory);
    }),
    {
      capacity: 1_024,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );
  const repositoryIdentity = Effect.fn("ManagedWorktrees.repositoryIdentity")(
    (workingDirectory: string) => Cache.get(repositoryIdentityCache, workingDirectory),
  );
  const withRepositoryLock = Effect.fn("ManagedWorktrees.withRepositoryLock")(function* <A, E, R>(
    workingDirectory: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* repositoryLock(yield* repositoryIdentity(workingDirectory), effect);
  });
  const revParseExists = Effect.fn("ManagedWorktrees.revParseExists")(function* (
    cwd: string,
    ref: string,
  ) {
    return (yield* Effect.result(git(cwd, "rev-parse", "--verify", "-q", ref)))._tag === "Success";
  });
  const revListCount = Effect.fn("ManagedWorktrees.revListCount")(function* (
    cwd: string,
    ...revisions: ReadonlyArray<string>
  ) {
    return Number.parseInt((yield* git(cwd, "rev-list", "--count", ...revisions)).trim(), 10) || 0;
  });
  const dirtyFileCount = Effect.fn("ManagedWorktrees.dirtyFileCount")(function* (cwd: string) {
    return (yield* git(cwd, "status", "--porcelain"))
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  });
  const isAncestor = Effect.fn("ManagedWorktrees.isAncestor")(function* (
    cwd: string,
    ancestor: string,
    descendant: string,
  ) {
    return (
      (yield* Effect.result(git(cwd, "merge-base", "--is-ancestor", ancestor, descendant)))._tag ===
      "Success"
    );
  });
  const rebaseInProgress = Effect.fn("ManagedWorktrees.rebaseInProgress")(function* (cwd: string) {
    for (const marker of ["rebase-merge", "rebase-apply"]) {
      const gitPath = yield* gitOptional(cwd, ["rev-parse", "--git-path", marker]);
      if (
        gitPath._tag === "Some" &&
        gitPath.value &&
        (yield* exists(path.resolve(cwd, gitPath.value)))
      )
        return true;
    }
    return false;
  });
  const unmergedFiles = Effect.fn("ManagedWorktrees.unmergedFiles")(function* (cwd: string) {
    return (yield* git(cwd, "diff", "--name-only", "--diff-filter=U"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  });

  return {
    git,
    gitMutation,
    gitOptional,
    exists,
    repositoryRoot,
    repositoryIdentity,
    withRepositoryLock,
    withWorktreeLock,
    revParseExists,
    revListCount,
    dirtyFileCount,
    isAncestor,
    rebaseInProgress,
    unmergedFiles,
  };
});
export type WorktreeRepository = Effect.Success<ReturnType<typeof makeWorktreeRepository>>;
