import { Effect, Layer } from "effect";
import { Git } from "../git/Git";
import { WorktreeStorage } from "../storage/WorktreeStorage";
import { ManagedWorktreeEngine } from "./ManagedWorktreeEngine";
import { ManagedWorktreeError, ManagedWorktrees } from "./ManagedWorktrees";

const worktreeError = (operation: string, cause: unknown) =>
  new ManagedWorktreeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const ManagedWorktreesLive: Layer.Layer<ManagedWorktrees, never, Git | WorktreeStorage> =
  Layer.effect(
    ManagedWorktrees,
    Effect.gen(function* () {
      const git = yield* Git;
      const storage = yield* WorktreeStorage;
      const context = yield* Effect.context<Git | WorktreeStorage>();
      const run = Effect.runPromiseWith(context);
      const engine = new ManagedWorktreeEngine(
        {
          load: () => run(storage.load()),
          save: (records) => run(storage.save(records)),
        },
        (workingDirectory, arguments_) => run(git.run(workingDirectory, arguments_)),
      );
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
          (projectPath, baseWorktreePath, worktreeName) =>
            attempt("ManagedWorktrees.create", () =>
              engine.create(projectPath, baseWorktreePath, worktreeName),
            ),
        ),
        status: Effect.fn("ManagedWorktrees.status")((worktreePath) =>
          attempt("ManagedWorktrees.status", () => engine.status(worktreePath)),
        ),
        land: Effect.fn("ManagedWorktrees.land")((worktreePath, request) =>
          attempt("ManagedWorktrees.land", () => engine.land(worktreePath, { request })),
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
          attempt("ManagedWorktrees.proposeSquashMessage", () =>
            engine.proposeSquashMessage(input),
          ),
        ),
      });
    }),
  );
