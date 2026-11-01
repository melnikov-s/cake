import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { AutomationSourceEvent } from "../../contracts/automations/automation-data";

/** Process-scoped source-event fanout. Durable automation occurrences are owned separately. */
export class AutomationEvents extends Context.Service<
  AutomationEvents,
  {
    readonly publish: (event: AutomationSourceEvent) => Effect.Effect<void>;
    readonly events: () => Stream.Stream<AutomationSourceEvent>;
  }
>()("cake/services/automations/AutomationEvents") {
  static readonly layer = Layer.effect(
    AutomationEvents,
    Effect.gen(function* () {
      const events = yield* Effect.acquireRelease(
        PubSub.unbounded<AutomationSourceEvent>(),
        PubSub.shutdown,
      );
      return AutomationEvents.of({
        publish: Effect.fn("AutomationEvents.publish")((event: AutomationSourceEvent) =>
          PubSub.publish(events, event).pipe(Effect.asVoid),
        ),
        events: () => Stream.fromPubSub(events),
      });
    }),
  );
}
