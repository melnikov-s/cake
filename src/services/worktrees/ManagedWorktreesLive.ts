import { Deferred, Effect, HashMap, Layer, Option, PubSub, Ref, Stream } from "effect";
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
    const scope = yield* Effect.scope;
    const changes = yield* PubSub.bounded<ManagedWorktreeCatalogUpdate>({ capacity: 1_024 });
    const deferredSetups = yield* Ref.make(
      HashMap.empty<string, Deferred.Deferred<void, ManagedWorktreeError>>(),
    );
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
      createWithBackgroundSetup: Effect.fn("ManagedWorktrees.createWithBackgroundSetup")(
        function* (projectPath, baseWorktreePath, worktreeName, settings) {
          const record = yield* attempt("ManagedWorktrees.createWithBackgroundSetup", () =>
            engine.createWithoutSetup(projectPath, baseWorktreePath, worktreeName, settings),
          );
          const completion = yield* Deferred.make<void, ManagedWorktreeError>();
          yield* Ref.update(deferredSetups, HashMap.set(record.worktreePath, completion));
          yield* Effect.forkIn(
            attempt("ManagedWorktrees.setup", () =>
              engine.setup(record.worktreePath, settings),
            ).pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  Deferred.succeed(completion, undefined).pipe(
                    Effect.andThen(Ref.update(deferredSetups, HashMap.remove(record.worktreePath))),
                    Effect.asVoid,
                  ),
                onFailure: (error) =>
                  Deferred.fail(completion, error).pipe(
                    Effect.andThen(Effect.logError("Managed Worktree setup failed", error)),
                    Effect.asVoid,
                  ),
              }),
            ),
            scope,
          );
          yield* publish(record.worktreePath);
          return record;
        },
      ),
      awaitSetup: Effect.fn("ManagedWorktrees.awaitSetup")(function* (worktreePath) {
        const completion = HashMap.get(yield* Ref.get(deferredSetups), worktreePath);
        return yield* Option.match(completion, {
          onNone: () => Effect.void,
          onSome: Deferred.await,
        });
      }),
      hasDeferredSetup: Effect.fn("ManagedWorktrees.hasDeferredSetup")(function* (worktreePath) {
        return HashMap.has(yield* Ref.get(deferredSetups), worktreePath);
      }),
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
