import { Clock, Effect, type Semaphore } from "effect";

/** Measure only the storage boundary, not SDK admission or result delivery. */
export const timedStorageRead = Effect.fn("Storage.timedRead")(function* <A, E, R>(
  operation: "SessionFamilyStorage.state" | "RecoveryRecordFiles.get",
  lock: Semaphore.Semaphore,
  read: Effect.Effect<A, E, R>,
) {
  const clock = yield* Clock.Clock;
  const startedAt = clock.monotonicTimeNanosUnsafe();
  let acquiredAt: bigint | undefined;
  let completed = false;
  return yield* lock
    .withPermit(
      Effect.gen(function* () {
        acquiredAt = clock.monotonicTimeNanosUnsafe();
        const result = yield* read;
        completed = true;
        return result;
      }),
    )
    .pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          const finishedAt = clock.monotonicTimeNanosUnsafe();
          const totalMs = Number(finishedAt - startedAt) / 1e6;
          if (totalMs < 1_000) return Effect.void;
          // Fixed operation labels and numeric evidence only: never record IDs,
          // filenames, document contents or error text. Waiting is not read work.
          return Effect.logWarning("Slow storage read", {
            operation,
            completed,
            phase: acquiredAt === undefined ? "wait" : "read",
            phasesMs: {
              wait: Number((acquiredAt ?? finishedAt) - startedAt) / 1e6,
              read: acquiredAt === undefined ? 0 : Number(finishedAt - acquiredAt) / 1e6,
            },
            totalMs,
          });
        }),
      ),
    );
});
