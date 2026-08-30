import { Context, Effect, Layer, SynchronizedRef } from "effect";
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

export class ApplicationState extends Context.Service<
  ApplicationState,
  {
    readonly initialize: () => Effect.Effect<ApplicationStateValue, ApplicationStorageError>;
    readonly current: () => Effect.Effect<ApplicationStateValue>;
    readonly unsafeCurrent: () => ApplicationStateValue;
    readonly transact: <E>(
      transition: (current: ApplicationStateValue) => Effect.Effect<ApplicationStateValue, E>,
    ) => Effect.Effect<ApplicationStateValue, ApplicationEncodeError | ApplicationWriteError | E>;
  }
>()("cake/services/storage/ApplicationState") {
  static readonly layer = Layer.effect(
    ApplicationState,
    Effect.gen(function* () {
      const storage = yield* ApplicationStorage;
      const state = yield* SynchronizedRef.make(defaultApplicationState());

      // Main owns this process-lifetime projection. ApplicationStorage is the
      // persistence authority; SynchronizedRef serializes publication after a
      // successful write, and transact serializes concurrent mutations.
      const initialize = Effect.fn("ApplicationState.initialize")(function* () {
        const loaded = yield* storage.load();
        return yield* SynchronizedRef.setAndGet(state, loaded.state);
      });
      const current = Effect.fn("ApplicationState.current")(() => SynchronizedRef.get(state));
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
        current,
        unsafeCurrent: () => SynchronizedRef.getUnsafe(state),
        transact,
      });
    }),
  );
}
