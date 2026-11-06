import { Context, Effect, Layer, Semaphore, SubscriptionRef, type Stream } from "effect";
import type { AutomationError } from "../../contracts/automations/automation-data";
import { AutomationStorage, type AutomationLedger } from "../storage/AutomationStorage";

export interface AutomationRecordSnapshot extends AutomationLedger {
  readonly revision: number;
}

/** Serialized metadata admission/persistence and a gap-free projection, not an execution engine. */
export class AutomationRecords extends Context.Service<
  AutomationRecords,
  {
    readonly initialize: () => Effect.Effect<void, AutomationError>;
    readonly snapshot: () => AutomationRecordSnapshot;
    readonly changes: () => Stream.Stream<AutomationRecordSnapshot>;
    /** Publish a fresh joined view after Pi activity or another authority changes; no ledger write. */
    readonly refresh: () => Effect.Effect<void>;
    readonly transact: <A, E>(
      transition: (ledger: AutomationLedger) => Effect.Effect<
        {
          readonly ledger: AutomationLedger;
          readonly result: A;
        },
        E
      >,
    ) => Effect.Effect<A, E | AutomationError>;
  }
>()("cake/services/automations/AutomationRecords") {
  static readonly layer = Layer.effect(
    AutomationRecords,
    Effect.gen(function* () {
      const storage = yield* AutomationStorage;
      const projection = yield* SubscriptionRef.make<AutomationRecordSnapshot>({
        revision: 0,
        automations: [],
        occurrences: [],
        runs: [],
        artifactSchedules: [],
        pausedArtifactIds: [],
      });
      const gate = yield* Semaphore.make(1);
      const initialize = Effect.fn("AutomationRecords.initialize")(function* () {
        const ledger = yield* storage.load();
        yield* SubscriptionRef.set(projection, { ...ledger, revision: 1 });
      }, gate.withPermits(1));
      const transact = Effect.fn("AutomationRecords.transact")(
        <A, E>(
          transition: (
            ledger: AutomationLedger,
          ) => Effect.Effect<{ readonly ledger: AutomationLedger; readonly result: A }, E>,
        ) =>
          gate.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(projection);
              const next = yield* transition(current);
              yield* storage.save(next.ledger).pipe(
                Effect.andThen(
                  SubscriptionRef.set(projection, {
                    ...next.ledger,
                    revision: current.revision + 1,
                  }),
                ),
                Effect.uninterruptible,
              );
              return next.result;
            }),
          ),
      );
      const refresh = Effect.fn("AutomationRecords.refresh")(() =>
        gate.withPermits(1)(
          SubscriptionRef.update(projection, (current) => ({
            ...current,
            revision: current.revision + 1,
          })),
        ),
      );
      return AutomationRecords.of({
        initialize,
        refresh,
        snapshot: () => SubscriptionRef.getUnsafe(projection),
        changes: () => SubscriptionRef.changes(projection),
        transact,
      });
    }),
  );
}
