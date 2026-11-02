import { Context, Effect, Layer, Queue, Stream } from "effect";
import type { AutomationSourceEvent } from "../../contracts/automations/automation-data";

/** One process-scoped event consumer; queue admission survives listener startup, not process exit.
 * Durable accepted automation occurrences are owned separately. */
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
        Queue.unbounded<AutomationSourceEvent>(),
        Queue.shutdown,
      );
      return AutomationEvents.of({
        publish: Effect.fn("AutomationEvents.publish")((event: AutomationSourceEvent) =>
          Queue.offer(events, event).pipe(Effect.asVoid),
        ),
        events: () => Stream.fromQueue(events),
      });
    }),
  );
}
