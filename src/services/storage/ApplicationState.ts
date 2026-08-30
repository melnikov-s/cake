import { Context, Effect, Layer, SynchronizedRef } from "effect";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../domain/application-data";
import { ApplicationStorage, type ApplicationStorageError } from "./ApplicationStorage";

export class ApplicationState extends Context.Service<
  ApplicationState,
  {
    readonly initialize: Effect.Effect<ApplicationStateValue, ApplicationStorageError>;
    readonly current: Effect.Effect<ApplicationStateValue>;
    readonly unsafeCurrent: () => ApplicationStateValue;
    readonly transact: <E>(
      transition: (current: ApplicationStateValue) => Effect.Effect<ApplicationStateValue, E>,
    ) => Effect.Effect<ApplicationStateValue, ApplicationStorageError | E>;
  }
>()("cake/services/storage/ApplicationState") {
  static readonly layer = Layer.effect(
    ApplicationState,
    Effect.gen(function* () {
      const storage = yield* ApplicationStorage;
      const state = yield* SynchronizedRef.make(defaultApplicationState());

      const initialize = storage.load.pipe(
        Effect.flatMap((loaded) => SynchronizedRef.setAndGet(state, loaded.state)),
      );
      const transact = Effect.fn("ApplicationState.transact")(
        <E>(
          transition: (current: ApplicationStateValue) => Effect.Effect<ApplicationStateValue, E>,
        ) =>
          SynchronizedRef.updateAndGetEffect(state, (current) =>
            transition(current).pipe(
              Effect.flatMap((next) => storage.save(next).pipe(Effect.as(next))),
            ),
          ),
      );

      return ApplicationState.of({
        initialize,
        current: SynchronizedRef.get(state),
        unsafeCurrent: () => SynchronizedRef.getUnsafe(state),
        transact,
      });
    }),
  );
}
