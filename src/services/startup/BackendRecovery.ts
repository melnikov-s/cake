import { Cause, Context, Deferred, Effect, Layer } from "effect";

/** The native shell may start while reconciliation runs. Backend RPC admission
 * waits for this process-owned gate; recovery itself must not wait on its gate.
 */
export class BackendRecovery extends Context.Service<
  BackendRecovery,
  { readonly awaitReady: () => Effect.Effect<void> }
>()("cake/services/startup/BackendRecovery") {}

/** Required startup work, not optional lazy work. No automatic retry: replay and
 * orphan reconciliation must retain their own durable idempotency policy.
 * Defects remain in the gate and are logged even when no request is waiting.
 */
export const makeBackendRecoveryLive = <R>(reconcile: Effect.Effect<void, never, R>) =>
  Layer.effect(
    BackendRecovery,
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      yield* Deferred.complete(
        ready,
        reconcile.pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Backend restart recovery failed", Cause.pretty(cause)),
          ),
        ),
      ).pipe(Effect.forkScoped);
      return BackendRecovery.of({
        awaitReady: Effect.fn("BackendRecovery.awaitReady")(() => Deferred.await(ready)),
      });
    }),
  );
