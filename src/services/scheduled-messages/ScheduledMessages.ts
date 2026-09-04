import { Context, Effect, Layer, SubscriptionRef, type Stream } from "effect";
import type {
  ScheduledMessage,
  ScheduledMessageSnapshot,
} from "../../domain/scheduled-message-data";
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

      const initialize = Effect.fn("ScheduledMessages.initialize")(function* () {
        const messages = yield* storage.load();
        return yield* SubscriptionRef.updateAndGet(projection, (current) => ({
          revision: current.revision + 1,
          messages: [...messages].sort((left, right) => left.sendAt.localeCompare(right.sendAt)),
        }));
      });
      const transact = Effect.fn("ScheduledMessages.transact")(
        <E>(
          transition: (
            messages: ReadonlyArray<ScheduledMessage>,
          ) => Effect.Effect<ReadonlyArray<ScheduledMessage>, E>,
        ) =>
          SubscriptionRef.updateAndGetEffect(projection, (current) =>
            transition(current.messages).pipe(
              Effect.map((messages) =>
                [...messages].sort((left, right) => left.sendAt.localeCompare(right.sendAt)),
              ),
              Effect.flatMap((messages) => storage.save(messages).pipe(Effect.as(messages))),
              Effect.map((messages) => ({ revision: current.revision + 1, messages })),
            ),
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
