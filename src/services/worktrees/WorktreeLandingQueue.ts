import { Clock, Deferred, Effect, Stream, SubscriptionRef } from "effect";
import type { LandingQueueWait } from "../../contracts/worktrees/landing-queue";
import {
  diagnosticId,
  landingMark,
  measureLanding,
} from "../diagnostics/responsiveness-diagnostics";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import type { WorktreeRepository } from "./WorktreeRepository";

interface LandingEntry {
  readonly operationId: string;
  readonly worktreePath: string;
  readonly ready: Deferred.Deferred<void, Error>;
  readonly reservedAt: number;
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
  const landingQueues = yield* SubscriptionRef.make(new Map<string, LandingQueue>());
  const observe = () =>
    SubscriptionRef.changes(landingQueues).pipe(
      Stream.map((queues) => {
        const waits: LandingQueueWait[] = [];
        for (const queue of queues.values()) {
          if (!queue.active) continue;
          for (const [index, entry] of queue.pending.entries())
            waits.push({
              operationId: entry.operationId,
              blockingOperationId: queue.active.operationId,
              position: index + 1,
              queuedAt: entry.reservedAt,
            });
        }
        return waits;
      }),
    );
  const landingState = Effect.fn("ManagedWorktrees.landingState")(function* (
    record: WorktreeRecord,
  ) {
    const queue = (yield* SubscriptionRef.get(landingQueues)).get(
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
    const promoted = yield* SubscriptionRef.modify(landingQueues, (queues) => {
      const queue = queues.get(repository);
      if (!queue || queue.active?.operationId !== operationId) return [undefined, queues] as const;
      const [nextActive, ...pending] = queue.pending;
      const next = new Map(queues);
      if (nextActive) next.set(repository, { active: nextActive, pending });
      else next.delete(repository);
      return [nextActive ? { entry: nextActive, pending } : undefined, next] as const;
    });
    if (promoted) {
      // Wake the FIFO owner before recording diagnostics; logging must not hold admission.
      yield* Deferred.succeed(promoted.entry.ready, undefined);
      const now = yield* Clock.currentTimeMillis;
      yield* landingMark(promoted.entry.operationId, "queue-admitted", {
        durationMs: Math.max(0, now - promoted.entry.reservedAt),
      });
      for (const entry of promoted.pending)
        yield* landingMark(entry.operationId, "queue-blocker-changed", {
          blocker: diagnosticId(promoted.entry.operationId),
          durationMs: Math.max(0, now - entry.reservedAt),
        });
    }
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
      reservedAt: yield* Clock.currentTimeMillis,
    };
    const repository = yield* repositoryIdentity(record.projectPath);
    const reservation = yield* SubscriptionRef.modify<
      Map<string, LandingQueue>,
      {
        waiting: Deferred.Deferred<void, Error> | undefined;
        inserted: boolean;
        blocker: string | undefined;
      }
    >(landingQueues, (queues) => {
      const current = queues.get(repository);
      if (current?.active?.operationId === operationId)
        return [{ waiting: undefined, inserted: false, blocker: undefined }, queues] as const;
      const existing = current?.pending.find((item) => item.operationId === operationId);
      if (existing)
        return [
          { waiting: existing.ready, inserted: false, blocker: current?.active?.operationId },
          queues,
        ] as const;
      const next = new Map(queues);
      if (!current) next.set(repository, { active: entry, pending: [] });
      else next.set(repository, { ...current, pending: [...current.pending, entry] });
      return [
        {
          waiting: current ? ready : undefined,
          inserted: true,
          blocker: current?.active?.operationId,
        },
        next,
      ] as const;
    });
    if (reservation.inserted) {
      const fields = { workspace: diagnosticId(record.worktreePath) };
      if (reservation.blocker)
        Object.assign(fields, { blocker: diagnosticId(reservation.blocker) });
      yield* landingMark(
        operationId,
        reservation.waiting ? "queue-reserved" : "queue-owner",
        fields,
      );
    }
    const waiting = reservation.waiting;
    if (waiting && waitForTurn)
      yield* (onQueued ?? Effect.void).pipe(
        Effect.andThen(measureLanding(operationId, "queue-wait", Deferred.await(waiting))),
        Effect.onInterrupt(() => cancelLandingInternal(record, operationId, false)),
      );
  });
  const cancelLandingInternal = Effect.fn("ManagedWorktrees.cancelLandingInternal")(function* (
    record: WorktreeRecord,
    operationId: string,
    onlyIfQueued: boolean,
  ) {
    const repository = yield* repositoryIdentity(record.projectPath);
    const result = yield* SubscriptionRef.modify<
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
    } else if (result.entry) {
      yield* Deferred.fail(result.entry.ready, new Error("Worktree landing was canceled."));
      const now = yield* Clock.currentTimeMillis;
      yield* landingMark(operationId, "queue-canceled", {
        durationMs: Math.max(0, now - result.entry.reservedAt),
      });
    }
    return result !== "missing";
  });

  const remove = Effect.fn("ManagedWorktrees.removeLandingReservations")(function* (
    record: WorktreeRecord,
  ) {
    const normalized = resolveNormalized(record.worktreePath);
    const queue = (yield* SubscriptionRef.get(landingQueues)).get(
      yield* repositoryIdentity(record.projectPath),
    );
    for (const pending of queue?.pending ?? [])
      if (pending.worktreePath === normalized)
        yield* cancelLandingInternal(record, pending.operationId, false);
    if (queue?.active?.worktreePath === normalized)
      yield* releaseLanding(record, queue.active.operationId);
  });
  return { landingState, acquireLanding, releaseLanding, cancelLandingInternal, remove, observe };
});
