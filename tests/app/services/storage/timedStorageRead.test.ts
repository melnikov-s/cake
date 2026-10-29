import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Logger, Semaphore } from "effect";
import { expect } from "vitest";
import { timedStorageRead } from "../../../../src/services/storage/internal/timedStorageRead";

const withDiagnostics = Effect.fn("TimedStorageReadTest.withDiagnostics")(function* <A, E, R>(
  test: (advance: (ms: number) => void, messages: unknown[]) => Effect.Effect<A, E, R>,
) {
  const clock = yield* Clock.Clock;
  let nanos = 0n;
  const messages: unknown[] = [];
  return yield* test((ms) => {
    nanos += BigInt(ms) * 1_000_000n;
  }, messages).pipe(
    Effect.provideService(Clock.Clock, {
      ...clock,
      monotonicTimeNanosUnsafe: () => nanos,
      monotonicTimeNanos: Effect.sync(() => nanos),
    }),
    Effect.provide(
      Logger.layer([
        Logger.make(({ message }) => {
          messages.push(message);
        }),
      ]),
    ),
  );
});

it.effect("storage diagnostics separate lock wait from reads without weakening serialization", () =>
  withDiagnostics((advance, messages) =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* timedStorageRead(
        "SessionFamilyStorage.state",
        lock,
        Effect.gen(function* () {
          yield* Deferred.succeed(reading, undefined);
          yield* Deferred.await(release);
          return "PRIVATE_DOCUMENT";
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(reading);
      advance(2_000);
      let secondRead = false;
      const second = yield* timedStorageRead(
        "RecoveryRecordFiles.get",
        lock,
        Effect.sync(() => {
          secondRead = true;
          return "PRIVATE_SESSION";
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      advance(3_000);
      expect(secondRead).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toBe("PRIVATE_DOCUMENT");
      expect(yield* Fiber.join(second)).toBe("PRIVATE_SESSION");
      expect(messages).toEqual([
        [
          "Slow storage read",
          {
            operation: "SessionFamilyStorage.state",
            completed: true,
            phase: "read",
            phasesMs: { wait: 0, read: 5_000 },
            totalMs: 5_000,
          },
        ],
        [
          "Slow storage read",
          {
            operation: "RecoveryRecordFiles.get",
            completed: true,
            phase: "read",
            phasesMs: { wait: 3_000, read: 0 },
            totalMs: 3_000,
          },
        ],
      ]);
      // Fast reads stay quiet, and no result contents become diagnostic fields.
      yield* timedStorageRead("RecoveryRecordFiles.get", lock, Effect.succeed("PRIVATE_FAST"));
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain("PRIVATE");
    }),
  ),
);

it.effect("failed storage reads preserve their error and release the permit", () =>
  withDiagnostics((advance, messages) =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const failure = yield* timedStorageRead(
        "SessionFamilyStorage.state",
        lock,
        Effect.gen(function* () {
          advance(1_500);
          return yield* Effect.fail("PRIVATE_ERROR");
        }),
      ).pipe(Effect.flip);
      expect(failure).toBe("PRIVATE_ERROR");
      expect(messages).toEqual([
        [
          "Slow storage read",
          {
            operation: "SessionFamilyStorage.state",
            completed: false,
            phase: "read",
            phasesMs: { wait: 0, read: 1_500 },
            totalMs: 1_500,
          },
        ],
      ]);
      expect(
        yield* timedStorageRead("SessionFamilyStorage.state", lock, Effect.succeed("ok")),
      ).toBe("ok");
      expect(messages).toHaveLength(1);
    }),
  ),
);

it.effect("interrupted lock waits are not reported as read work", () =>
  withDiagnostics((advance, messages) =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(0);
      let read = false;
      const waiting = yield* timedStorageRead(
        "RecoveryRecordFiles.get",
        lock,
        Effect.sync(() => {
          read = true;
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      advance(2_000);
      yield* Fiber.interrupt(waiting);
      expect(read).toBe(false);
      expect(messages).toEqual([
        [
          "Slow storage read",
          {
            operation: "RecoveryRecordFiles.get",
            completed: false,
            phase: "wait",
            phasesMs: { wait: 2_000, read: 0 },
            totalMs: 2_000,
          },
        ],
      ]);
      yield* lock.resize(1);
      yield* timedStorageRead("RecoveryRecordFiles.get", lock, Effect.void);
      expect(messages).toHaveLength(1);
    }),
  ),
);

it.effect("interrupted reads report elapsed work and release the permit", () =>
  withDiagnostics((advance, messages) =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const reading = yield* Deferred.make<void>();
      const worker = yield* timedStorageRead(
        "SessionFamilyStorage.state",
        lock,
        Effect.gen(function* () {
          yield* Deferred.succeed(reading, undefined);
          yield* Effect.never;
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(reading);
      advance(1_500);
      yield* Fiber.interrupt(worker);
      expect(messages).toEqual([
        [
          "Slow storage read",
          {
            operation: "SessionFamilyStorage.state",
            completed: false,
            phase: "read",
            phasesMs: { wait: 0, read: 1_500 },
            totalMs: 1_500,
          },
        ],
      ]);
      yield* timedStorageRead("SessionFamilyStorage.state", lock, Effect.void);
      expect(messages).toHaveLength(1);
    }),
  ),
);
