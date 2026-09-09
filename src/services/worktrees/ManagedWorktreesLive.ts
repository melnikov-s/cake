import { Effect, Layer, PubSub, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { ManagedWorktreeCatalogUpdate } from "../../domain/worktrees/managed-worktree-data";
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
    const changes = yield* PubSub.bounded<ManagedWorktreeCatalogUpdate>({ capacity: 1_024 });
    const attempt = <A>(operation: string, execute: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: execute,
        catch: (cause) => worktreeError(operation, cause),
      });
    const records = Effect.fn("ManagedWorktrees.records")(() =>
      attempt("ManagedWorktrees.records", () => engine.records()),
    );
    const publish = Effect.fn("ManagedWorktrees.publish")((worktreePath: string) =>
      Effect.gen(function* () {
        const record = (yield* records()).find((item) => item.worktreePath === worktreePath);
        if (record)
          yield* PubSub.publish(changes, {
            _tag: "Event",
            event: { _tag: "Upserted", worktree: record },
          });
      }).pipe(Effect.asVoid),
    );

    return ManagedWorktrees.of({
      records,
      observe: () =>
        Stream.unwrap(
          PubSub.subscribe(changes).pipe(
            Effect.map((subscription) =>
              Stream.fromEffect(
                records().pipe(
                  Effect.map((worktrees) => ({ _tag: "Snapshot" as const, worktrees })),
                ),
              ).pipe(Stream.concat(Stream.fromSubscription(subscription))),
            ),
          ),
        ),
      create: Effect.fn("ManagedWorktrees.create")(
        function* (projectPath, baseWorktreePath, worktreeName, settings) {
          const record = yield* attempt("ManagedWorktrees.create", () =>
            engine.create(projectPath, baseWorktreePath, worktreeName, settings),
          );
          yield* publish(record.worktreePath);
          return record;
        },
      ),
      status: Effect.fn("ManagedWorktrees.status")(function* (worktreePath) {
        const status = yield* attempt("ManagedWorktrees.status", () => engine.status(worktreePath));
        yield* publish(worktreePath);
        return status;
      }),
      prepareLanding: Effect.fn("ManagedWorktrees.prepareLanding")((worktreePath, operationId) =>
        attempt("ManagedWorktrees.prepareLanding", (signal) =>
          engine.prepareLanding(worktreePath, operationId, signal),
        ),
      ),
      setResolveAfterLanding: Effect.fn("ManagedWorktrees.setResolveAfterLanding")(
        function* (worktreePath, enabled) {
          yield* attempt("ManagedWorktrees.setResolveAfterLanding", () =>
            engine.setResolveAfterLanding(worktreePath, enabled),
          );
          yield* publish(worktreePath);
        },
      ),
      land: Effect.fn("ManagedWorktrees.land")(function* (worktreePath, operationId, request) {
        const outcome = yield* attempt("ManagedWorktrees.land", (signal) =>
          engine.land(worktreePath, { request, operationId, signal }),
        );
        yield* publish(worktreePath);
        return outcome;
      }),
      cancelLanding: Effect.fn("ManagedWorktrees.cancelLanding")(
        (worktreePath, operationId, onlyIfQueued) =>
          attempt("ManagedWorktrees.cancelLanding", () =>
            engine.cancelLanding(worktreePath, operationId, onlyIfQueued),
          ),
      ),
      rebase: Effect.fn("ManagedWorktrees.rebase")((worktreePath) =>
        attempt("ManagedWorktrees.rebase", () => engine.rebase(worktreePath)),
      ),
      discard: Effect.fn("ManagedWorktrees.discard")(function* (worktreePath, keepBranch) {
        yield* attempt("ManagedWorktrees.discard", () => engine.discard(worktreePath, keepBranch));
        yield* publish(worktreePath);
      }),
      cleanupResolved: Effect.fn("ManagedWorktrees.cleanupResolved")(function* (worktreePath) {
        yield* attempt("ManagedWorktrees.cleanupResolved", () =>
          engine.cleanupResolved(worktreePath),
        );
        yield* publish(worktreePath);
      }),
      restoreResolved: Effect.fn("ManagedWorktrees.restoreResolved")(function* (worktreePath) {
        const record = yield* attempt("ManagedWorktrees.restoreResolved", () =>
          engine.restoreResolved(worktreePath),
        );
        yield* publish(worktreePath);
        return record;
      }),
      proposeSquashMessage: Effect.fn("ManagedWorktrees.proposeSquashMessage")((input) =>
        attempt("ManagedWorktrees.proposeSquashMessage", () => engine.proposeSquashMessage(input)),
      ),
    });
  }),
);
