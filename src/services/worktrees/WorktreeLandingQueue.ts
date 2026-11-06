import { Deferred, Effect, Ref } from "effect";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import type { WorktreeRepository } from "./WorktreeRepository";

interface LandingEntry {
  readonly operationId: string;
  readonly worktreePath: string;
  readonly ready: Deferred.Deferred<void, Error>;
}
interface LandingQueue {
  readonly active: LandingEntry | undefined;
  readonly pending: ReadonlyArray<LandingEntry>;
}

const internalError = (message: string) => Effect.fail(new Error(message));
const resolveNormalized = (path: string) => path.replace(/\/+$/, "");

/** One repository-identity keyed FIFO authority, shared by prepare, resume, cancel and cleanup. */
export const makeWorktreeLandingQueue = Effect.fn("ManagedWorktrees.makeLandingQueue")(function* (
  repositoryIdentity: WorktreeRepository["repositoryIdentity"],
) {
  const landingQueues = yield* Ref.make(new Map<string, LandingQueue>());
  const landingState = Effect.fn("ManagedWorktrees.landingState")(function* (
    record: WorktreeRecord,
  ) {
    const queue = (yield* Ref.get(landingQueues)).get(
      yield* repositoryIdentity(record.projectPath),
    );
    if (!queue) return undefined;
    const normalized = resolveNormalized(record.worktreePath);
    if (queue.active?.worktreePath === normalized)
      return { state: "running" as const, operationId: queue.active.operationId };
    const index = queue.pending.findIndex((entry) => entry.worktreePath === normalized);
    const entry = queue.pending[index];
    return entry
      ? { state: "queued" as const, operationId: entry.operationId, position: index + 1 }
      : undefined;
  });
  const releaseLanding = Effect.fn("ManagedWorktrees.releaseLanding")(function* (
    record: WorktreeRecord,
    operationId: string,
  ) {
    const repository = yield* repositoryIdentity(record.projectPath);
    const promoted = yield* Ref.modify(landingQueues, (queues) => {
      const queue = queues.get(repository);
      if (!queue || queue.active?.operationId !== operationId) return [undefined, queues] as const;
      const [nextActive, ...pending] = queue.pending;
      const next = new Map(queues);
      if (nextActive) next.set(repository, { active: nextActive, pending });
      else next.delete(repository);
      return [nextActive?.ready, next] as const;
    });
    if (promoted) yield* Deferred.succeed(promoted, undefined);
  });
  const acquireLanding = Effect.fn("ManagedWorktrees.acquireLanding")(function* (
    record: WorktreeRecord,
    operationId: string,
    onQueued?: Effect.Effect<void>,
    waitForTurn = true,
  ) {
    const ready = yield* Deferred.make<void, Error>();
    const entry: LandingEntry = {
      operationId,
      worktreePath: resolveNormalized(record.worktreePath),
      ready,
    };
    const repository = yield* repositoryIdentity(record.projectPath);
    const waiting = yield* Ref.modify(landingQueues, (queues) => {
      const current = queues.get(repository);
      if (current?.active?.operationId === operationId) return [undefined, queues] as const;
      const existing = current?.pending.find((item) => item.operationId === operationId);
      if (existing) return [existing.ready, queues] as const;
      const next = new Map(queues);
      if (!current) next.set(repository, { active: entry, pending: [] });
      else next.set(repository, { ...current, pending: [...current.pending, entry] });
      return [current ? ready : undefined, next] as const;
    });
    if (waiting && waitForTurn)
      yield* (onQueued ?? Effect.void).pipe(
        Effect.andThen(Deferred.await(waiting)),
        Effect.onInterrupt(() => cancelLandingInternal(record, operationId, false)),
      );
  });
  const cancelLandingInternal = Effect.fn("ManagedWorktrees.cancelLandingInternal")(function* (
    record: WorktreeRecord,
    operationId: string,
    onlyIfQueued: boolean,
  ) {
    const repository = yield* repositoryIdentity(record.projectPath);
    const result = yield* Ref.modify<
      Map<string, LandingQueue>,
      "missing" | "active" | { readonly _tag: "pending"; readonly entry: LandingEntry }
    >(landingQueues, (queues) => {
      const queue = queues.get(repository);
      if (!queue) return ["missing" as const, queues] as const;
      if (queue.active?.operationId === operationId) return ["active" as const, queues] as const;
      const index = queue.pending.findIndex((entry) => entry.operationId === operationId);
      if (index < 0) return ["missing" as const, queues] as const;
      const entry = queue.pending[index];
      if (!entry) return ["missing" as const, queues] as const;
      const next = new Map(queues);
      next.set(repository, {
        ...queue,
        pending: queue.pending.filter((_, itemIndex) => itemIndex !== index),
      });
      return [{ _tag: "pending" as const, entry }, next] as const;
    });
    if (result === "active") {
      if (onlyIfQueued)
        return yield* internalError("This merge has already started and cannot be canceled.");
      yield* releaseLanding(record, operationId);
    } else if (result === "missing") {
      if (onlyIfQueued)
        return yield* internalError("This merge has already started and cannot be canceled.");
    } else if (result.entry)
      yield* Deferred.fail(result.entry.ready, new Error("Worktree landing was canceled."));
    return result !== "missing";
  });

  const remove = Effect.fn("ManagedWorktrees.removeLandingReservations")(function* (
    record: WorktreeRecord,
  ) {
    const normalized = resolveNormalized(record.worktreePath);
    const queue = (yield* Ref.get(landingQueues)).get(
      yield* repositoryIdentity(record.projectPath),
    );
    for (const pending of queue?.pending ?? [])
      if (pending.worktreePath === normalized)
        yield* cancelLandingInternal(record, pending.operationId, false);
    if (queue?.active?.worktreePath === normalized)
      yield* releaseLanding(record, queue.active.operationId);
  });
  return { landingState, acquireLanding, releaseLanding, cancelLandingInternal, remove };
});
