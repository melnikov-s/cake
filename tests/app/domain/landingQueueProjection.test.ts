import { it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import type { WorktreeOperationCatalogUpdate } from "../../../src/contracts/worktrees/worktree-operation-data";
import type { WorktreeLandingOperation } from "../../../src/contracts/worktrees/worktree-landing-data";
import { observeOperations } from "../../../src/domain/worktrees/worktreeLandings";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { makeWorktreeLandingQueue } from "../../../src/services/worktrees/WorktreeLandingQueue";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../src/services/worktrees/WorktreeLandingCoordinator";

const record = (name: string): WorktreeRecord => ({
  projectPath: "/repo",
  worktreePath: `/trees/${name}`,
  branch: name,
  baseBranch: "main",
  createdAt: "2026-01-01T00:00:00Z",
});
const operation = (
  name: string,
  phase: WorktreeLandingOperation["phase"],
): WorktreeLandingOperation => ({
  operationId: name,
  workspacePath: `/trees/${name}`,
  sessionId: `session-${name}`,
  kind: "landing",
  phase,
  allowDirtyTarget: false,
});

it.effect(
  "pushes authoritative blocker/owner-phase changes, FIFO promotion and canceled waiter removal",
  () =>
    Effect.gen(function* () {
      const queue = yield* makeWorktreeLandingQueue(() => Effect.succeed("/repo/.git"));
      yield* Effect.gen(function* () {
        const coordinator = yield* WorktreeLandingCoordinator;
        const states = yield* Queue.unbounded<WorktreeOperationCatalogUpdate>();
        yield* (yield* observeOperations()).pipe(
          Stream.runForEach((value) => Queue.offer(states, value)),
          Effect.forkScoped,
        );
        yield* Queue.take(states); // Observation is installed before any mutations.
        const snapshot = (predicate: (value: WorktreeOperationCatalogUpdate) => boolean) =>
          Stream.fromQueue(states).pipe(
            Stream.filter(predicate),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        const set = (name: string, phase: WorktreeLandingOperation["phase"]) =>
          SubscriptionRef.update(coordinator.state, (state) => ({
            ...state,
            operations: new Map(state.operations).set(`/trees/${name}`, operation(name, phase)),
          }));
        yield* set("first", "resolving");
        yield* set("second", "queued");
        yield* set("third", "queued");
        yield* queue.acquireLanding(record("first"), "first");
        const admitted = yield* Deferred.make<void>();
        const second = yield* queue
          .acquireLanding(record("second"), "second", Deferred.succeed(admitted, undefined))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(admitted);
        const queuedAt = yield* Clock.currentTimeMillis;
        yield* queue.acquireLanding(record("third"), "third", undefined, false);
        const initial = yield* snapshot(
          (value) =>
            value.operations.find((op) => op.operationId === "third")?.queue?.position === 2,
        );
        expect(initial.operations.find((op) => op.operationId === "third")?.queue).toEqual({
          blockingOperationId: "first",
          blockingSessionId: "session-first",
          blockingPhase: "resolving",
          position: 2,
          queuedAt,
        });
        yield* TestClock.adjust(1000);
        yield* set("first", "stalled");
        const paused = yield* snapshot(
          (value) =>
            value.operations.find((op) => op.operationId === "third")?.queue?.blockingPhase ===
            "stalled",
        );
        expect(paused.operations.find((op) => op.operationId === "third")?.queue?.queuedAt).toBe(
          queuedAt,
        );
        yield* queue.releaseLanding(record("first"), "first");
        yield* Fiber.join(second);
        yield* set("second", "landing");
        const changed = yield* snapshot(
          (value) =>
            value.operations.find((op) => op.operationId === "third")?.queue?.blockingPhase ===
            "landing",
        );
        expect(changed.operations.find((op) => op.operationId === "third")?.queue).toMatchObject({
          blockingOperationId: "second",
          blockingSessionId: "session-second",
          position: 1,
          queuedAt,
        });
        yield* queue.cancelLandingInternal(record("third"), "third", true);
        const canceled = yield* snapshot(
          (value) => !value.operations.find((op) => op.operationId === "third")?.queue,
        );
        expect(
          canceled.operations.find((op) => op.operationId === "second")?.queue,
        ).toBeUndefined();
        expect(yield* queue.landingState(record("second"))).toEqual({
          state: "running",
          operationId: "second",
        });
        yield* set("second", "failed");
        yield* queue.cancelLandingInternal(record("second"), "second", false);
        expect(yield* queue.landingState(record("second"))).toBeUndefined();
      }).pipe(
        Effect.provide(
          Layer.merge(
            WorktreeLandingCoordinatorLive,
            Layer.mock(ManagedWorktrees, { observeLandingQueue: queue.observe }),
          ),
        ),
      );
    }),
);
