import { Effect, Layer } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { Git } from "../git/Git";
import type { WorktreeStorage } from "../storage/WorktreeStorage";
import { makeManagedWorktreeEngineAdapter } from "./ManagedWorktreeEngineAdapter";
import { ManagedWorktreeError, ManagedWorktrees } from "./ManagedWorktrees";

const worktreeError = (operation: string, cause: unknown) =>
  new ManagedWorktreeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const ManagedWorktreesLive: Layer.Layer<
  ManagedWorktrees,
  never,
  Git | WorktreeStorage | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  ManagedWorktrees,
  Effect.gen(function* () {
    const engine = yield* makeManagedWorktreeEngineAdapter;
    const attempt = <A>(operation: string, execute: () => Promise<A>) =>
      Effect.tryPromise({
        try: execute,
        catch: (cause) => worktreeError(operation, cause),
      });

    return ManagedWorktrees.of({
      records: Effect.fn("ManagedWorktrees.records")(() =>
        attempt("ManagedWorktrees.records", () => engine.records()),
      ),
      create: Effect.fn("ManagedWorktrees.create")(
        (projectPath, baseWorktreePath, worktreeName, settings) =>
          attempt("ManagedWorktrees.create", () =>
            engine.create(projectPath, baseWorktreePath, worktreeName, settings),
          ),
      ),
      status: Effect.fn("ManagedWorktrees.status")((worktreePath) =>
        attempt("ManagedWorktrees.status", () => engine.status(worktreePath)),
      ),
      land: Effect.fn("ManagedWorktrees.land")((worktreePath, request) =>
        attempt("ManagedWorktrees.land", () => engine.land(worktreePath, { request })),
      ),
      rebase: Effect.fn("ManagedWorktrees.rebase")((worktreePath) =>
        attempt("ManagedWorktrees.rebase", () => engine.rebase(worktreePath)),
      ),
      discard: Effect.fn("ManagedWorktrees.discard")((worktreePath, keepBranch) =>
        attempt("ManagedWorktrees.discard", () => engine.discard(worktreePath, keepBranch)),
      ),
      cleanupResolved: Effect.fn("ManagedWorktrees.cleanupResolved")((worktreePath) =>
        attempt("ManagedWorktrees.cleanupResolved", () => engine.cleanupResolved(worktreePath)),
      ),
      restoreResolved: Effect.fn("ManagedWorktrees.restoreResolved")((worktreePath) =>
        attempt("ManagedWorktrees.restoreResolved", () => engine.restoreResolved(worktreePath)),
      ),
      proposeSquashMessage: Effect.fn("ManagedWorktrees.proposeSquashMessage")((input) =>
        attempt("ManagedWorktrees.proposeSquashMessage", () => engine.proposeSquashMessage(input)),
      ),
    });
  }),
);
