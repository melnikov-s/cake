import { Context, Effect, Layer, Semaphore, SubscriptionRef, type Stream } from "effect";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../contracts/application/application-data";
import { ApplicationStorage, type ApplicationStorageError } from "./ApplicationStorage";
import {
  type ApplicationEncodeError,
  type ApplicationWriteError,
} from "../../contracts/storage/application-storage-errors";

export interface ApplicationStateProjection {
  readonly revision: number;
  readonly state: ApplicationStateValue;
}

export class ApplicationState extends Context.Service<
  ApplicationState,
  {
    readonly initialize: () => Effect.Effect<ApplicationStateValue, ApplicationStorageError>;
    readonly current: () => Effect.Effect<ApplicationStateValue>;
    readonly snapshot: () => ApplicationStateValue;
    readonly changes: () => Stream.Stream<ApplicationStateProjection>;
    readonly transact: <E>(
      transition: (current: ApplicationStateValue) => Effect.Effect<ApplicationStateValue, E>,
    ) => Effect.Effect<ApplicationStateValue, ApplicationEncodeError | ApplicationWriteError | E>;
  }
>()("cake/services/storage/ApplicationState") {
  static readonly layer = Layer.effect(
    ApplicationState,
    Effect.gen(function* () {
      const storage = yield* ApplicationStorage;
      const projection = yield* SubscriptionRef.make<ApplicationStateProjection>({
        revision: 0,
        state: defaultApplicationState(),
      });

      const mutations = yield* Semaphore.make(1);

      // Main owns this process-lifetime projection. ApplicationStorage is the persistence
      // authority; mutations serialize read/transition/commit, and SubscriptionRef provides
      // current-first observation without introducing another persisted application copy.
      const initialize = Effect.fn("ApplicationState.initialize")(function* () {
        const loaded = yield* storage.load();
        const next = yield* SubscriptionRef.updateAndGet(projection, (current) => ({
          revision: current.revision + 1,
          state: loaded.state,
        }));
        return next.state;
      }, mutations.withPermits(1));
      const current = Effect.fn("ApplicationState.current")(() =>
        SubscriptionRef.get(projection).pipe(Effect.map((current) => current.state)),
      );
      const transact = Effect.fn("ApplicationState.transact")(
        <E>(
          transition: (current: ApplicationStateValue) => Effect.Effect<ApplicationStateValue, E>,
        ) =>
          mutations.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(projection);
              const next = yield* transition(current.state);
              // The callback and lock wait remain interruptible. Once saving starts,
              // finish disk commit (including cleanup) and publication together.
              yield* storage.save(next).pipe(
                Effect.andThen(
                  SubscriptionRef.set(projection, {
                    revision: current.revision + 1,
                    state: next,
                  }),
                ),
                Effect.uninterruptible,
              );
              return next;
            }),
          ),
      );

      return ApplicationState.of({
        initialize,
        current,
        snapshot: () => SubscriptionRef.getUnsafe(projection).state,
        changes: () => SubscriptionRef.changes(projection),
        transact,
      });
    }),
  );
}
