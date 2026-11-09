import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe } from "vitest";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
  type ProjectCatalogItem,
} from "../../../../src/services/session-catalogs/SessionCatalogChanges";

describe("SessionCatalogChanges", () => {
  it.effect(
    "shares each publication, keeps every consumer independent, and never replays to late subscribers",
    () =>
      Effect.gen(function* () {
        const catalogs = yield* SessionCatalogChanges;
        let computations = 0;
        const project = () =>
          Effect.sync(() => {
            computations++;
            return [{ _tag: "Removed" as const, sessionId: String(computations) }];
          });
        const initial: ProjectCatalogItem = { _tag: "InitialBatch", sessions: [] };
        const queues = yield* Effect.forEach([1, 2, 3], () =>
          Queue.unbounded<ProjectCatalogItem>(),
        );
        const fibers = [];
        for (const queue of queues) {
          fibers.push(
            yield* catalogs
              .initialThenProjectChanges(Stream.succeed(initial), "same", project)
              .pipe(
                Stream.runForEach((item) => Queue.offer(queue, item)),
                Effect.forkScoped,
              ),
          );
          assert.deepEqual(yield* Queue.take(queue), initial);
        }
        const change: SessionCatalogChange = {
          _tag: "ProjectSessionRemoved",
          sessionId: "one",
          projectPath: "/project",
        };
        yield* catalogs.publish(change);
        for (const queue of queues)
          assert.deepEqual(yield* Queue.take(queue), { _tag: "Removed", sessionId: "1" });
        yield* Fiber.interrupt(fibers[0]!);
        yield* catalogs.publish(change); // even the same object is a new authoritative publication
        for (const queue of queues.slice(1))
          assert.deepEqual(yield* Queue.take(queue), { _tag: "Removed", sessionId: "2" });
        const late = yield* catalogs
          .initialThenProjectChanges(Stream.succeed(initial), "same", project)
          .pipe(Stream.take(1), Stream.runCollect);
        assert.deepEqual(late, [initial]);
        assert.equal(computations, 2);
      }).pipe(Effect.scoped, Effect.provide(SessionCatalogChanges.layer)),
  );

  it.effect("a cancelled consumer does not interrupt another consumer's pending projection", () =>
    Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let computations = 0;
      const project = () =>
        Effect.gen(function* () {
          computations++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return [{ _tag: "Removed" as const, sessionId: "fresh" }];
        });
      const first = yield* Queue.unbounded<ProjectCatalogItem>();
      const second = yield* Queue.unbounded<ProjectCatalogItem>();
      const subscribe = (queue: Queue.Queue<ProjectCatalogItem>) =>
        catalogs
          .initialThenProjectChanges(
            Stream.succeed({ _tag: "InitialBatch", sessions: [] }),
            "same",
            project,
          )
          .pipe(
            Stream.runForEach((item) => Queue.offer(queue, item)),
            Effect.forkScoped,
          );
      const cancelled = yield* subscribe(first);
      yield* Queue.take(first);
      yield* subscribe(second);
      yield* Queue.take(second);
      yield* catalogs.publish({
        _tag: "ProjectSessionRemoved",
        sessionId: "one",
        projectPath: "/project",
      });
      yield* Deferred.await(started);
      yield* TestClock.adjust(0);
      yield* Fiber.interrupt(cancelled);
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* Queue.take(second), { _tag: "Removed", sessionId: "fresh" });
      assert.equal(computations, 1);
    }).pipe(Effect.scoped, Effect.provide(SessionCatalogChanges.layer)),
  );

  it.effect(
    "never replays another window's older cached projection over a fresh initial snapshot",
    () =>
      Effect.gen(function* () {
        const catalogs = yield* SessionCatalogChanges;
        const release = yield* Deferred.make<void>();
        const scanning = yield* Deferred.make<void>();
        const fast = yield* Queue.unbounded<ProjectCatalogItem>();
        const slow = yield* Queue.unbounded<ProjectCatalogItem>();
        let value = 0;
        let computations = 0;
        const project = () =>
          Effect.sync(() => {
            computations++;
            return [{ _tag: "Removed" as const, sessionId: String(value) }];
          });
        yield* catalogs
          .initialThenProjectChanges(
            Stream.succeed({ _tag: "InitialBatch", sessions: [] }),
            "same",
            project,
          )
          .pipe(
            Stream.runForEach((item) => Queue.offer(fast, item)),
            Effect.forkScoped,
          );
        yield* Queue.take(fast);
        const initial = Stream.fromEffect(
          Deferred.succeed(scanning, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.map(() => ({ _tag: "Removed" as const, sessionId: `initial-${value}` })),
          ),
        );
        yield* catalogs.initialThenProjectChanges(initial, "same", project).pipe(
          Stream.runForEach((item) => Queue.offer(slow, item)),
          Effect.forkScoped,
        );
        yield* Deferred.await(scanning);
        const change: SessionCatalogChange = {
          _tag: "ProjectSessionRemoved",
          sessionId: "one",
          projectPath: "/project",
        };
        value = 1;
        yield* catalogs.publish(change);
        assert.deepEqual(yield* Queue.take(fast), { _tag: "Removed", sessionId: "1" });
        value = 2;
        yield* catalogs.publish(change);
        assert.deepEqual(yield* Queue.take(fast), { _tag: "Removed", sessionId: "2" });
        yield* Deferred.succeed(release, undefined);
        for (const sessionId of ["initial-2", "2", "2"])
          assert.deepEqual(yield* Queue.take(slow), { _tag: "Removed", sessionId });
        assert.equal(computations, 4, "only initial catch-up bypasses the shared projection");
      }).pipe(Effect.scoped, Effect.provide(SessionCatalogChanges.layer)),
  );

  it.effect("releases a pending projection when its last consumer cancels", () =>
    Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const started = yield* Deferred.make<void>();
      const finalized = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const consumer = yield* catalogs
        .initialThenProjectChanges(
          Stream.succeed({ _tag: "InitialBatch", sessions: [] }),
          "cancelled",
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
        )
        .pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.runDrain,
          Effect.forkScoped,
        );
      yield* Deferred.await(ready);
      yield* catalogs.publish({
        _tag: "ProjectSessionRemoved",
        sessionId: "one",
        projectPath: "/project",
      });
      yield* Deferred.await(started);
      yield* Fiber.interrupt(consumer);
      assert.equal(yield* Deferred.isDone(finalized), true);
    }).pipe(Effect.scoped, Effect.provide(SessionCatalogChanges.layer)),
  );

  it.effect("projected subscribers buffer changes published inside the initial scan", () =>
    Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const initial = Stream.fromEffect(
        catalogs
          .publish({
            _tag: "ProjectSessionRemoved",
            sessionId: "raced",
            projectPath: "/project",
          })
          .pipe(Effect.as({ _tag: "InitialBatch" as const, sessions: [] })),
      );
      const observed = yield* catalogs
        .initialThenProjectChanges(initial, "same", (change) =>
          Effect.succeed(
            change._tag === "ProjectSessionRemoved"
              ? [{ _tag: "Removed", sessionId: change.sessionId }]
              : [],
          ),
        )
        .pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(observed, [
        { _tag: "InitialBatch", sessions: [] },
        { _tag: "Removed", sessionId: "raced" },
      ]);
    }).pipe(Effect.provide(SessionCatalogChanges.layer)),
  );

  it.effect("subscribes before consuming the initial metadata scan", () =>
    Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      const change: SessionCatalogChange = {
        _tag: "CakeChatSessionChanged",
        sessionId: "session-1",
        resolved: false,
      };
      const initial = Stream.fromEffect(
        catalogs.publish(change).pipe(Effect.as("initial metadata" as const)),
      );

      const observed = Array.from(
        yield* catalogs.initialThenChanges(initial).pipe(Stream.take(2), Stream.runCollect),
      );

      assert.deepEqual(observed, ["initial metadata", change]);
    }).pipe(Effect.provide(SessionCatalogChanges.layer)),
  );
});
