import { Context, Effect, Layer, SubscriptionRef, type Stream } from "effect";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../domain/application-data";
import {
  ApplicationStorage,
  type ApplicationEncodeError,
  type ApplicationStorageError,
  type ApplicationWriteError,
} from "./ApplicationStorage";

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

      // Main owns this process-lifetime projection. ApplicationStorage is the persistence
      // authority; SubscriptionRef serializes publication after successful writes and provides
      // current-first observation without introducing another persisted application copy.
      const initialize = Effect.fn("ApplicationState.initialize")(function* () {
        const loaded = yield* storage.load();
        const next = yield* SubscriptionRef.updateAndGet(projection, (current) => ({
          revision: current.revision + 1,
          state: loaded.state,
        }));
        return next.state;
      });
      const current = Effect.fn("ApplicationState.current")(() =>
        SubscriptionRef.get(projection).pipe(Effect.map((current) => current.state)),
      );
      const transact = Effect.fn("ApplicationState.transact")(
        <E>(
          transition: (current: ApplicationStateValue) => Effect.Effect<ApplicationStateValue, E>,
        ) =>
          SubscriptionRef.updateAndGetEffect(projection, (current) =>
            transition(current.state).pipe(
              Effect.flatMap((next) => storage.save(next).pipe(Effect.as(next))),
              Effect.map((next) => ({ revision: current.revision + 1, state: next })),
            ),
          ).pipe(Effect.map((current) => current.state)),
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
