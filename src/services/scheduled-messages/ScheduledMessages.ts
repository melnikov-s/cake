import { Context, Effect, Layer, Semaphore, SubscriptionRef, type Stream } from "effect";
import type {
  ScheduledMessage,
  ScheduledMessageSnapshot,
} from "../../contracts/scheduled-messages/scheduled-message-data";
import {
  ScheduledMessageStorage,
  type ScheduledMessageStorageError,
} from "../storage/ScheduledMessageStorage";

export class ScheduledMessages extends Context.Service<
  ScheduledMessages,
  {
    readonly initialize: () => Effect.Effect<
      ScheduledMessageSnapshot,
      ScheduledMessageStorageError
    >;
    readonly snapshot: () => ScheduledMessageSnapshot;
    readonly changes: () => Stream.Stream<ScheduledMessageSnapshot>;
    readonly transact: <E>(
      transition: (
        messages: ReadonlyArray<ScheduledMessage>,
      ) => Effect.Effect<ReadonlyArray<ScheduledMessage>, E>,
    ) => Effect.Effect<ScheduledMessageSnapshot, ScheduledMessageStorageError | E>;
  }
>()("cake/services/scheduled-messages/ScheduledMessages") {
  static readonly layer = Layer.effect(
    ScheduledMessages,
    Effect.gen(function* () {
      const storage = yield* ScheduledMessageStorage;
      const projection = yield* SubscriptionRef.make<ScheduledMessageSnapshot>({
        revision: 0,
        messages: [],
      });

      const mutations = yield* Semaphore.make(1);

      const initialize = Effect.fn("ScheduledMessages.initialize")(function* () {
        const messages = yield* storage.load();
        return yield* SubscriptionRef.updateAndGet(projection, (current) => ({
          revision: current.revision + 1,
          messages: [...messages].sort((left, right) => left.sendAt.localeCompare(right.sendAt)),
        }));
      }, mutations.withPermits(1));
      const transact = Effect.fn("ScheduledMessages.transact")(
        <E>(
          transition: (
            messages: ReadonlyArray<ScheduledMessage>,
          ) => Effect.Effect<ReadonlyArray<ScheduledMessage>, E>,
        ) =>
          mutations.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(projection);
              const next = yield* transition(current.messages);
              const messages = [...next].sort((left, right) =>
                left.sendAt.localeCompare(right.sendAt),
              );
              // Protect only local persistence and publication, not the callback
              // or lock wait: cancellation must not strand a disk-only mutation.
              return yield* storage.save(messages).pipe(
                Effect.andThen(
                  SubscriptionRef.setAndGet(projection, {
                    revision: current.revision + 1,
                    messages,
                  }),
                ),
                Effect.uninterruptible,
              );
            }),
          ),
      );

      return ScheduledMessages.of({
        initialize,
        snapshot: () => SubscriptionRef.getUnsafe(projection),
        changes: () => SubscriptionRef.changes(projection),
        transact,
      });
    }),
  );
}
