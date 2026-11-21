import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import {
  changeFeedResync,
  makeChangeFeed,
  type ChangeFeedResync,
} from "../../../../src/services/change-feeds/ChangeFeed";

describe("ChangeFeed", () => {
  it.effect("a stalled subscriber costs only its own resync; others see every notice", () =>
    Effect.gen(function* () {
      const feed = yield* makeChangeFeed<number>({ name: "test", capacity: 4 });
      const resume = yield* Deferred.make<void>();
      const fast = yield* Queue.unbounded<number | ChangeFeedResync>();
      const slow = yield* Queue.unbounded<number | ChangeFeedResync>();
      yield* (yield* feed.subscribe()).pipe(
        Stream.runForEach((item) => Queue.offer(fast, item)),
        Effect.forkScoped,
      );
      // Subscribed now, but reads nothing until resumed.
      const stalled = yield* feed.subscribe();
      yield* Deferred.await(resume).pipe(
        Effect.andThen(stalled.pipe(Stream.runForEach((item) => Queue.offer(slow, item)))),
        Effect.forkScoped,
      );
      for (let value = 1; value <= 10; value++) {
        yield* feed.publish(value);
        expect(yield* Queue.take(fast)).toBe(value);
      }
      yield* Deferred.succeed(resume, undefined);
      expect(yield* Queue.take(slow)).toBe(changeFeedResync);
      yield* feed.publish(11);
      expect(yield* Queue.take(fast)).toBe(11);
      expect(yield* Queue.take(slow)).toBe(11);
      expect(yield* Queue.size(slow)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a subscriber that keeps up never sees a resync", () =>
    Effect.gen(function* () {
      const feed = yield* makeChangeFeed<number>({ name: "test", capacity: 4 });
      const items = yield* (yield* feed.subscribe()).pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.forEach([1, 2, 3, 4], feed.publish, { discard: true });
      expect(Array.from(yield* Fiber.join(items))).toEqual([1, 2, 3, 4]);
    }).pipe(Effect.scoped),
  );
});
