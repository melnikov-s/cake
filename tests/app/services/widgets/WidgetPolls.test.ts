import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { WidgetPolls } from "../../../../src/services/widgets/WidgetPolls";
import type { WidgetUpdate } from "../../../../src/contracts/widgets/widget-updates";

it.effect("shares one loop, replays to a second view, and stops at the last view's release", () =>
  Effect.gen(function* () {
    const polls = yield* WidgetPolls;
    const calls = yield* Ref.make(0);
    const read = Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.map((count): WidgetUpdate => ({ ok: true, result: count })),
    );
    const first = yield* Queue.unbounded<WidgetUpdate>();
    const second = yield* Queue.unbounded<WidgetUpdate>();
    const a = yield* polls.observe("shared-instance:query", 1000, read).pipe(
      Stream.runForEach((value) => Queue.offer(first, value)),
      Effect.forkScoped,
    );
    expect(yield* Queue.take(first)).toEqual({ ok: true, result: 1 });
    const b = yield* polls.observe("shared-instance:query", 1000, read).pipe(
      Stream.runForEach((value) => Queue.offer(second, value)),
      Effect.forkScoped,
    );
    expect(yield* Queue.take(second)).toEqual({ ok: true, result: 1 });
    expect(yield* Ref.get(calls)).toBe(1);
    yield* TestClock.adjust(1000);
    expect(yield* Queue.take(first)).toEqual({ ok: true, result: 2 });
    expect(yield* Queue.take(second)).toEqual({ ok: true, result: 2 });
    yield* Fiber.interrupt(a);
    yield* TestClock.adjust(1000);
    expect(yield* Queue.take(second)).toEqual({ ok: true, result: 3 });
    yield* Fiber.interrupt(b);
    yield* TestClock.adjust(10_000);
    expect(yield* Ref.get(calls)).toBe(3);
    const c = yield* polls.observe("shared-instance:query", 1000, read).pipe(
      Stream.runForEach((value) => Queue.offer(first, value)),
      Effect.forkScoped,
    );
    expect(yield* Queue.take(first)).toEqual({ ok: true, result: 4 });
    yield* Fiber.interrupt(c);
  }).pipe(Effect.provide(WidgetPolls.layer)),
);

it.effect("does not overlap slow requests and cancels in-flight work on view disposal", () =>
  Effect.gen(function* () {
    const polls = yield* WidgetPolls;
    const started = yield* Deferred.make<void>();
    const released = yield* Ref.make(false);
    const calls = yield* Ref.make(0);
    const read = Effect.gen(function* () {
      yield* Ref.update(calls, (count) => count + 1);
      yield* Deferred.succeed(started, undefined);
      return yield* Effect.never;
    }).pipe(Effect.ensuring(Ref.set(released, true)));
    const view = yield* polls
      .observe("slow-instance", 1000, read)
      .pipe(Stream.runDrain, Effect.forkScoped);
    yield* Deferred.await(started);
    yield* TestClock.adjust(10_000);
    expect(yield* Ref.get(calls)).toBe(1);
    yield* Fiber.interrupt(view);
    expect(yield* Ref.get(released)).toBe(true);
  }).pipe(Effect.provide(WidgetPolls.layer)),
);
