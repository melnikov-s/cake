import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect } from "vitest";
import type { WorktreeRecord } from "../../../../src/contracts/worktrees/managed-worktree-data";
import { makeWorktreeLandingQueue } from "../../../../src/services/worktrees/WorktreeLandingQueue";

const record = (name: string, projectPath = "/repo"): WorktreeRecord => ({
  projectPath,
  worktreePath: `/worktrees/${name}`,
  branch: `agent/${name}`,
  baseBranch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  state: "active",
});

describe("worktree landing reservations", () => {
  it.effect("promotes FIFO across repository aliases after a queued cancellation", () =>
    Effect.gen(function* () {
      const queue = yield* makeWorktreeLandingQueue(() => Effect.succeed("/repo/.git"));
      const first = record("first");
      const second = record("second", "/repo/subdirectory");
      const third = record("third", "/repo-symlink");
      yield* queue.acquireLanding(first, "first");
      const secondQueued = yield* Deferred.make<void>();
      const secondWait = yield* queue
        .acquireLanding(second, "second", Deferred.succeed(secondQueued, undefined))
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(secondQueued);
      const thirdQueued = yield* Deferred.make<void>();
      const thirdWait = yield* queue
        .acquireLanding(third, "third", Deferred.succeed(thirdQueued, undefined))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(thirdQueued);

      expect(yield* queue.landingState(third)).toEqual({
        state: "queued",
        operationId: "third",
        position: 2,
      });
      expect(yield* queue.cancelLandingInternal(second, "second", true)).toBe(true);
      expect(yield* Fiber.join(secondWait)).toMatchObject({ _tag: "Failure" });
      expect(yield* queue.landingState(third)).toEqual({
        state: "queued",
        operationId: "third",
        position: 1,
      });
      yield* queue.releaseLanding(first, "first");
      yield* Fiber.join(thirdWait);
      expect(yield* queue.landingState(third)).toEqual({
        state: "running",
        operationId: "third",
      });
      yield* queue.releaseLanding(third, "third");
      expect(yield* queue.landingState(third)).toBeUndefined();
    }),
  );

  it.effect("removes an interrupted waiter without releasing the active reservation", () =>
    Effect.gen(function* () {
      const queue = yield* makeWorktreeLandingQueue(() => Effect.succeed("/repo/.git"));
      const first = record("first");
      const second = record("second");
      yield* queue.acquireLanding(first, "first");
      const queued = yield* Deferred.make<void>();
      const waiting = yield* queue
        .acquireLanding(second, "second", Deferred.succeed(queued, undefined))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(queued);
      yield* Fiber.interrupt(waiting);
      expect(yield* queue.landingState(second)).toBeUndefined();
      expect(yield* queue.landingState(first)).toEqual({
        state: "running",
        operationId: "first",
      });
      expect(yield* Effect.result(queue.cancelLandingInternal(first, "first", true))).toMatchObject(
        {
          _tag: "Failure",
        },
      );
      expect(yield* queue.landingState(first)).toEqual({
        state: "running",
        operationId: "first",
      });
      yield* queue.releaseLanding(first, "first");
    }),
  );

  it.effect("keeps independent repository queues and removes checkout reservations", () =>
    Effect.gen(function* () {
      const queue = yield* makeWorktreeLandingQueue((projectPath) => Effect.succeed(projectPath));
      const first = record("first");
      const second = record("second", "/other");
      yield* queue.acquireLanding(first, "first");
      yield* queue.acquireLanding(second, "second");
      expect(yield* queue.landingState(second)).toEqual({
        state: "running",
        operationId: "second",
      });
      const queued = yield* Deferred.make<void>();
      const sameCheckout = { ...first, worktreePath: `${first.worktreePath}/` };
      const waiting = yield* queue
        .acquireLanding(sameCheckout, "retry", Deferred.succeed(queued, undefined))
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(queued);
      yield* queue.remove(first);
      expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: "Failure" });
      expect(yield* queue.landingState(first)).toBeUndefined();
      expect(yield* queue.landingState(second)).toEqual({
        state: "running",
        operationId: "second",
      });
    }),
  );
});
