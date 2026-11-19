import { Duration, Effect } from "effect";

/**
 * How long one runtime call (acquire, receipt, submit, publish) may take while a person waits
 * for a delivery. Pi admission normally answers in milliseconds; a call this slow is stuck, and
 * failing it releases the delivery lock with a visible error instead of hanging every send.
 */
export const DELIVERY_RUNTIME_TIMEOUT = Duration.seconds(30);

/** Fails a stuck runtime call with the caller's own error instead of waiting forever. */
export const withDeliveryDeadline =
  <E2>(onTimeout: () => E2) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: DELIVERY_RUNTIME_TIMEOUT,
        orElse: () => Effect.fail(onTimeout()),
      }),
    );
