import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type {
  ManagedWorktreeCatalogUpdate,
  WorktreeRecord,
} from "../../contracts/worktrees/managed-worktree-data";
import {
  worktreeStatusSchema,
  type WorktreeRebaseOutcome,
  type WorktreeStatus,
} from "../../contracts/worktrees/worktree-contract";
import { Git } from "../git/Git";
import { WorktreeStorage, type WorktreeStorageError } from "../storage/WorktreeStorage";
import { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import {
  ManagedWorktrees,
  type WorktreeCheckoutPlan,
  type WorktreeLifecycle,
  type WorktreeRemoveReason,
} from "./ManagedWorktrees";
import type { WorktreeCommands } from "./WorktreeCommands";
import { makeWorktreeRepository } from "./WorktreeRepository";
import { makeWorktreeCheckout } from "./WorktreeCheckout";
import { makeWorktreeLanding } from "./WorktreeLanding";
import { makeWorktreeLandingQueue } from "./WorktreeLandingQueue";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const internalError = (message: string) => Effect.fail(new Error(message));
const resolveNormalized = (path: string) => path.replace(/\/+$/, "");
/** Effect-native Managed Worktree capability. Mutable authority is held in Refs,
 * repository mutations use keyed Effect Semaphores, and landing reservations use
 * interruptible Deferred queues with exact FIFO promotion. */
export const ManagedWorktreesLive: Layer.Layer<
  ManagedWorktrees,
  WorktreeStorageError,
  Git | WorktreeStorage | FileSystem.FileSystem | Path.Path | WorktreeCommands
> = Layer.effect(
  ManagedWorktrees,
  Effect.gen(function* () {
    const gitService = yield* Git;
    const storage = yield* WorktreeStorage;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scope = yield* Effect.scope;
    const initialRecords = yield* storage.load();
    const recordsRef = yield* Ref.make<ReadonlyArray<WorktreeRecord>>(initialRecords);
    const recordsLock = yield* Semaphore.make(1);
    const repository = yield* makeWorktreeRepository();
    const {
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
    } = repository;
    const deferredSetups = yield* Ref.make(
      new Map<string, Deferred.Deferred<void, ManagedWorktreeError>>(),
    );
    const changes = yield* PubSub.bounded<ManagedWorktreeCatalogUpdate>({ capacity: 1_024 });

    const mapError = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new ManagedWorktreeError({ operation, message: messageOf(cause) }),
        ),
      );
    const mutateRecords = Effect.fn("ManagedWorktrees.mutateRecords")(function* (
      change: (records: ReadonlyArray<WorktreeRecord>) => ReadonlyArray<WorktreeRecord>,
    ) {
      yield* recordsLock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(recordsRef);
            const next = change(current);
            if (next === current) return;
            yield* restore(storage.save(next)).pipe(
              Effect.onInterrupt(() => storage.save(current).pipe(Effect.ignore)),
            );
            yield* Ref.set(recordsRef, next);
          }),
        ),
      );
    });
    const updateRecord = Effect.fn("ManagedWorktrees.updateRecord")(function* (
      record: WorktreeRecord,
      change: (record: WorktreeRecord) => WorktreeRecord,
    ) {
      yield* mutateRecords((records) => {
        const index = records.findIndex(
          (current) =>
            resolveNormalized(current.worktreePath) === resolveNormalized(record.worktreePath),
        );
        const current = records[index];
        return index < 0 || !current ? records : records.with(index, change(current));
      });
    });
    const closeRecord = Effect.fn("ManagedWorktrees.closeRecord")(function* (
      record: WorktreeRecord,
      state: "landed" | "resolved" | "discarded" | "missing",
      landedSourceCommit?: string,
    ) {
      yield* updateRecord(record, (current) => {
        const retainPreviousState =
          state === "resolved" && (current.state === "landed" || current.state === "discarded");
        const closed = {
          ...current,
          state,
          resolvedFrom: retainPreviousState ? current.state : undefined,
        } satisfies WorktreeRecord;
        if (landedSourceCommit) closed.landedSourceCommit = landedSourceCommit;
        Reflect.deleteProperty(closed, "pendingStrategy");
        if (state === "landed") Reflect.deleteProperty(closed, "pendingLandedSourceCommit");
        return closed;
      });
    });
    const publish = Effect.fn("ManagedWorktrees.publish")(function* (worktreePath: string) {
      const record = (yield* Ref.get(recordsRef)).find(
        (item) => item.worktreePath === worktreePath,
      );
      if (record)
        yield* PubSub.publish(changes, {
          _tag: "Event",
          event: { _tag: "Upserted", worktree: record },
        });
    });
    const checkout = yield* makeWorktreeCheckout(
      repository,
      recordsRef,
      mutateRecords,
      updateRecord,
    );
    const { factsOf, removeCheckout, runSetup, createRecord } = checkout;

    const landingQueue = yield* makeWorktreeLandingQueue(repositoryIdentity);
    const { landingState, acquireLanding, releaseLanding, cancelLandingInternal } = landingQueue;

    const landing = yield* makeWorktreeLanding(repository, recordsRef, updateRecord, closeRecord);
    const {
      withLandingCheckpoint,
      newCommitCount,
      rebaseOntoTarget,
      requireSourceBranch,
      hasFreshProposal,
      landRecord,
    } = landing;
    /** Removes the checkout with its project's command outside the repository lock, then
     * updates the branch and record under it. */
    const cleanup = Effect.fn("ManagedWorktrees.cleanup")(function* (
      record: WorktreeRecord,
      options: {
        readonly keepBranch: boolean;
        readonly state: "discarded" | "resolved";
        readonly reason: WorktreeRemoveReason;
        readonly lifecycle: WorktreeLifecycle;
      },
    ) {
      const normalized = resolveNormalized(record.worktreePath);
      const dependents = (yield* Ref.get(recordsRef)).filter(
        (entry) =>
          entry.parentWorktreePath !== undefined &&
          resolveNormalized(entry.parentWorktreePath) === normalized &&
          ["active", "landed"].includes(entry.state ?? "active"),
      );
      for (const child of dependents)
        if (yield* exists(child.worktreePath))
          return yield* internalError(
            "Remove child worktrees before removing their landing target.",
          );
      yield* landing.clearProposal(record);
      const facts = factsOf(record);
      if (yield* exists(facts.checkoutPath))
        yield* removeCheckout(facts, options.lifecycle, options.reason);
      else if (!options.lifecycle.removeCommand)
        yield* gitMutation(record.projectPath, "worktree", "prune");
      yield* withRepositoryLock(
        record.projectPath,
        Effect.gen(function* () {
          if (
            !options.keepBranch &&
            (yield* revParseExists(record.projectPath, `refs/heads/${record.branch}`))
          )
            yield* gitMutation(record.projectPath, "branch", "-D", record.branch);
          yield* closeRecord(record, options.state);
        }),
      );
      // Removed checkouts cannot retain reservations, including a paused squash landing.
      yield* landingQueue.remove(record);
    });

    const records = Effect.fn("ManagedWorktrees.records")(function* () {
      return [...(yield* Ref.get(recordsRef))];
    });
    const statusInternal = Effect.fn("ManagedWorktrees.statusInternal")(function* (
      worktreePath: string,
    ): Effect.fn.Return<WorktreeStatus | undefined, unknown> {
      const normalized = resolveNormalized(worktreePath);
      let record = (yield* Ref.get(recordsRef)).find(
        (entry) => resolveNormalized(entry.worktreePath) === normalized,
      );
      if (!record || !["active", "landed"].includes(record.state ?? "active")) return undefined;
      if (!(yield* exists(record.worktreePath))) {
        yield* closeRecord(record, "missing");
        return undefined;
      }
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      if (!(yield* exists(targetPath)))
        return yield* internalError("The worktree landing target no longer exists");
      record = yield* withLandingCheckpoint(record);
      const [
        dirtyCount,
        aheadCount,
        behindCount,
        merged,
        targetDirty,
        targetBranch,
        merging,
        rebasing,
      ] = yield* Effect.all(
        [
          dirtyFileCount(record.worktreePath),
          newCommitCount(record),
          revListCount(record.worktreePath, `HEAD..${record.baseBranch}`),
          record.state === "landed"
            ? Effect.succeed(true)
            : isAncestor(record.worktreePath, "HEAD", record.baseBranch),
          dirtyFileCount(targetPath).pipe(Effect.map((count) => count > 0)),
          gitOptional(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
            Effect.map((value) => (value._tag === "Some" ? value.value : undefined)),
          ),
          revParseExists(record.worktreePath, "MERGE_HEAD"),
          rebaseInProgress(record.worktreePath),
        ] as const,
        { concurrency: "unbounded" },
      );
      const landing = yield* landingState(record);
      return yield* Schema.decodeUnknownEffect(worktreeStatusSchema)({
        record,
        targetBranch: record.baseBranch,
        dirtyCount,
        aheadCount,
        behindCount,
        merged,
        targetDirty,
        targetOnBranch: targetBranch === record.baseBranch,
        merging,
        rebasing,
        squashMessageReady: yield* hasFreshProposal(record),
        ...(landing?.state === "queued"
          ? {
              landingState: landing.state,
              landingOperationId: landing.operationId,
              landingQueuePosition: landing.position,
            }
          : landing
            ? { landingState: landing.state, landingOperationId: landing.operationId }
            : {}),
      });
    });

    const service = ManagedWorktrees.of({
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
      createCheckout: Effect.fn("ManagedWorktrees.createCheckout")(function* (
        projectPath: string,
        prepare: (
          repository: string,
          registeredProjectPath: string,
          records: ReadonlyArray<WorktreeRecord>,
        ) => Effect.Effect<
          WorktreeCheckoutPlan,
          ManagedWorktreeError,
          Git | FileSystem.FileSystem | Path.Path
        >,
        backgroundSetup: boolean,
      ) {
        const operation = backgroundSetup
          ? "ManagedWorktrees.createWithBackgroundSetup"
          : "ManagedWorktrees.create";
        return yield* mapError(
          operation,
          Effect.gen(function* () {
            const registered = path.resolve(projectPath);
            const root = yield* fileSystem.realPath(yield* repositoryRoot(projectPath));
            // Planning and the branch that reserves its name share the repository lock; the
            // checkout and setup commands, which can be slow, run outside it.
            const plan = yield* withRepositoryLock(
              root,
              Effect.gen(function* () {
                const plan = yield* prepare(root, registered, yield* Ref.get(recordsRef)).pipe(
                  Effect.provideService(Git, gitService),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                );
                yield* gitMutation(root, "branch", "--no-track", plan.branch, plan.baseCommit);
                return plan;
              }),
            );
            const record = yield* createRecord(root, plan, backgroundSetup);
            if (backgroundSetup) {
              const completion = yield* Deferred.make<void, ManagedWorktreeError>();
              yield* Ref.update(deferredSetups, (setups) =>
                new Map(setups).set(record.worktreePath, completion),
              );
              yield* runSetup(record, plan.lifecycle).pipe(
                (effect) => mapError("ManagedWorktrees.setup", effect),
                Effect.matchEffect({
                  onSuccess: () =>
                    Deferred.succeed(completion, undefined).pipe(
                      Effect.andThen(
                        Ref.update(deferredSetups, (setups) => {
                          const next = new Map(setups);
                          next.delete(record.worktreePath);
                          return next;
                        }),
                      ),
                      Effect.asVoid,
                    ),
                  onFailure: (error) =>
                    Deferred.fail(completion, error).pipe(
                      Effect.andThen(Effect.logError("Managed Worktree setup failed", error)),
                      Effect.asVoid,
                    ),
                }),
                Effect.forkIn(scope),
              );
            }
            yield* publish(record.worktreePath);
            return record;
          }),
        );
      }),
      awaitSetup: (worktreePath) =>
        Effect.gen(function* () {
          const completion = (yield* Ref.get(deferredSetups)).get(worktreePath);
          if (!completion) return;
          // A failed setup is reported to the starts already waiting, then forgotten so a later
          // start can use the worktree as it is.
          yield* Deferred.await(completion).pipe(
            Effect.tapError(() =>
              Ref.update(deferredSetups, (setups) => {
                if (setups.get(worktreePath) !== completion) return setups;
                const next = new Map(setups);
                next.delete(worktreePath);
                return next;
              }),
            ),
          );
        }),
      status: (worktreePath) =>
        mapError(
          "ManagedWorktrees.status",
          statusInternal(worktreePath).pipe(Effect.tap(() => publish(worktreePath))),
        ),
      prepareLanding: Effect.fn("ManagedWorktrees.prepareLanding")((worktreePath, operationId) =>
        mapError(
          "ManagedWorktrees.prepareLanding",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* acquireLanding(record, operationId, undefined, false);
          }),
        ),
      ),
      setResolveAfterLanding: (worktreePath, enabled) =>
        mapError(
          "ManagedWorktrees.setResolveAfterLanding",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) => resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* updateRecord(record, (current) => {
              const next = { ...current };
              if (enabled) next.resolveAfterLanding = true;
              else Reflect.deleteProperty(next, "resolveAfterLanding");
              return next;
            });
            yield* publish(worktreePath);
          }),
        ),
      land: (worktreePath, operationId, request, onProgress, authorize) =>
        mapError(
          "ManagedWorktrees.land",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* acquireLanding(record, operationId, undefined, false);
            return yield* Effect.gen(function* () {
              // Waiting entries may replay and request owner repairs without taking the
              // repository lock or waiting for the head's commit/conflict turn.
              if (
                (yield* landingState(record))?.state === "queued" &&
                !(request.strategy === "preserve" && request.expectedSourceCommit)
              ) {
                const prepared = yield* withWorktreeLock(
                  record.worktreePath,
                  (authorize ?? Effect.void).pipe(
                    Effect.andThen(landRecord(record, request, true)),
                  ),
                );
                if (prepared.outcome !== "ready") {
                  yield* publish(worktreePath);
                  return prepared;
                }
              }
              // Never hold a worktree lock while waiting for FIFO promotion.
              yield* acquireLanding(record, operationId, onProgress?.("queued"));
              yield* onProgress?.("landing") ?? Effect.void;
              const outcome = yield* withWorktreeLock(
                record.worktreePath,
                withWorktreeLock(
                  record.parentWorktreePath ?? record.projectPath,
                  withRepositoryLock(
                    record.projectPath,
                    (authorize ?? Effect.void).pipe(Effect.andThen(landRecord(record, request))),
                  ),
                ),
              );
              // landRecord refreshes source, checkpoint and target under the final locks.
              if (outcome.outcome === "landed") yield* releaseLanding(record, operationId);
              yield* publish(worktreePath);
              if (outcome.outcome === "ready")
                return yield* internalError("Landing unexpectedly stopped after preparation");
              return outcome;
            }).pipe(Effect.tapCause(() => cancelLandingInternal(record, operationId, false)));
          }),
        ),
      cancelLanding: Effect.fn("ManagedWorktrees.cancelLanding")(
        (worktreePath, operationId, onlyIfQueued = false) =>
          mapError(
            "ManagedWorktrees.cancelLanding",
            Effect.gen(function* () {
              const record = (yield* Ref.get(recordsRef)).find(
                (entry) =>
                  resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
              );
              if (record) {
                const canceled = yield* cancelLandingInternal(record, operationId, onlyIfQueued);
                if (canceled && !onlyIfQueued) {
                  // Dismissal must abandon the durable pause too, or inspect will adopt it again.
                  yield* updateRecord(record, (current) => {
                    const next = { ...current };
                    Reflect.deleteProperty(next, "pendingStrategy");
                    return next;
                  });
                  yield* landing.clearProposal(record);
                  yield* publish(worktreePath);
                }
              } else if (onlyIfQueued)
                return yield* internalError(
                  "This merge has already started and cannot be canceled.",
                );
            }),
          ),
      ),
      rebase: (worktreePath) =>
        mapError(
          "ManagedWorktrees.rebase",
          Effect.gen(function* (): Effect.fn.Return<WorktreeRebaseOutcome, unknown, never> {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            return yield* withWorktreeLock(
              record.worktreePath,
              Effect.gen(function* () {
                if (!(yield* exists(record.worktreePath))) {
                  yield* closeRecord(record, "missing");
                  return yield* internalError("The worktree no longer exists on disk");
                }
                if (yield* rebaseInProgress(record.worktreePath))
                  return {
                    outcome: "resolving" as const,
                    files: yield* unmergedFiles(record.worktreePath),
                  };
                if ((yield* dirtyFileCount(record.worktreePath)) > 0)
                  return yield* internalError(
                    "The worktree has uncommitted changes. Commit or discard them first.",
                  );
                yield* requireSourceBranch(record);
                const targetPath = record.parentWorktreePath ?? record.projectPath;
                if (!(yield* exists(targetPath)))
                  return yield* internalError("The worktree rebase target no longer exists");
                const targetHead = (yield* git(
                  record.worktreePath,
                  "rev-parse",
                  record.baseBranch,
                )).trim();
                if ((yield* revListCount(record.worktreePath, `HEAD..${targetHead}`)) === 0)
                  return { outcome: "rebased" as const };
                const checkpointRecord = yield* withLandingCheckpoint(record);
                const conflicts = yield* rebaseOntoTarget(checkpointRecord, targetHead);
                return conflicts
                  ? ({ outcome: "resolving", files: conflicts } as const)
                  : ({ outcome: "rebased" } as const);
              }),
            );
          }),
        ),
      discard: (worktreePath, keepBranch, lifecycle) =>
        mapError(
          "ManagedWorktrees.discard",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* withWorktreeLock(
              record.worktreePath,
              cleanup(record, { keepBranch, state: "discarded", reason: "discard", lifecycle }),
            );
            yield* publish(worktreePath);
          }),
        ),
      cleanupResolved: (worktreePath, options) =>
        mapError(
          "ManagedWorktrees.cleanupResolved",
          Effect.gen(function* () {
            const normalized = resolveNormalized(worktreePath);
            const eligible = (record: WorktreeRecord | undefined): record is WorktreeRecord =>
              record !== undefined &&
              (record.state === "landed" ||
                record.state === "discarded" ||
                (options.retireActive && (record.state ?? "active") === "active"));
            const find = Effect.map(Ref.get(recordsRef), (records) =>
              records.find((entry) => resolveNormalized(entry.worktreePath) === normalized),
            );
            const pending = yield* find;
            if (!eligible(pending)) return false;
            const retired = yield* withWorktreeLock(
              pending.worktreePath,
              Effect.gen(function* () {
                // Decide under the repository lock; the removal command itself runs outside it.
                const decision = yield* withRepositoryLock(
                  pending.projectPath,
                  Effect.gen(function* () {
                    const record = yield* find;
                    if (!eligible(record)) return undefined;
                    if (record.state === "discarded") {
                      yield* closeRecord(record, "resolved");
                      return undefined;
                    }
                    const landed = record.state === "landed";
                    if (!(yield* exists(record.worktreePath)))
                      return { record, keepBranch: !landed };
                    const blocked =
                      (yield* dirtyFileCount(record.worktreePath)) > 0 ||
                      (yield* rebaseInProgress(record.worktreePath)) ||
                      (yield* revParseExists(record.worktreePath, "MERGE_HEAD"));
                    if (landed) {
                      const checkpoint = yield* withLandingCheckpoint(record);
                      if (blocked || (yield* newCommitCount(checkpoint)) > 0)
                        return yield* internalError(
                          "The worktree has unlanded work. Land or explicitly discard it before cleanup.",
                        );
                      return { record, keepBranch: false };
                    }
                    // Unlanded work is never forced away. Without uncommitted changes the checkout is
                    // disposable; its branch keeps any commits for review or a later restore.
                    if (blocked) return undefined;
                    const commits = yield* revListCount(
                      record.worktreePath,
                      `${record.baseCommit ?? record.baseBranch}..refs/heads/${record.branch}`,
                    );
                    return { record, keepBranch: commits > 0 };
                  }),
                );
                if (decision)
                  yield* cleanup(decision.record, {
                    keepBranch: decision.keepBranch,
                    state: "resolved",
                    reason: "resolve",
                    lifecycle: options.lifecycle,
                  });
                return decision !== undefined || pending.state === "discarded";
              }),
            );
            yield* publish(worktreePath);
            return retired;
          }),
        ),
      restoreResolved: (worktreePath, lifecycle) =>
        mapError(
          "ManagedWorktrees.restoreResolved",
          checkout
            .restoreResolved(worktreePath, lifecycle)
            .pipe(Effect.tap(() => publish(worktreePath))),
        ),
      proposeSquashMessage: (input) =>
        mapError("ManagedWorktrees.proposeSquashMessage", landing.proposeSquashMessage(input)),
    });
    return service;
  }),
);
