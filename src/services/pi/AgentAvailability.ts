import { Context, Effect, Layer, SubscriptionRef, type Stream } from "effect";
import type {
  AgentAvailabilityEntry,
  AgentAvailabilitySnapshot,
} from "../../domain/application/agent-availability-data";

export class AgentAvailability extends Context.Service<
  AgentAvailability,
  {
    readonly changes: () => Stream.Stream<AgentAvailabilitySnapshot>;
    readonly setGlobal: (availability: AgentAvailabilityEntry) => Effect.Effect<void>;
    readonly setWorkingDirectory: (
      workingDirectory: string,
      availability: AgentAvailabilityEntry,
    ) => Effect.Effect<void>;
  }
>()("cake/services/pi/AgentAvailability") {
  static readonly layer = Layer.effect(
    AgentAvailability,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<AgentAvailabilitySnapshot>({
        revision: 0,
        global: { state: "available" },
        workingDirectories: [],
      });
      const update = (
        transition: (current: AgentAvailabilitySnapshot) => AgentAvailabilitySnapshot,
      ) => SubscriptionRef.update(state, transition);
      return AgentAvailability.of({
        changes: () => SubscriptionRef.changes(state),
        setGlobal: Effect.fn("AgentAvailability.setGlobal")((availability) =>
          update((current) => ({
            ...current,
            revision: current.revision + 1,
            global: availability,
          })),
        ),
        setWorkingDirectory: Effect.fn("AgentAvailability.setWorkingDirectory")(
          (workingDirectory, availability) =>
            update((current) => ({
              ...current,
              revision: current.revision + 1,
              workingDirectories: [
                ...current.workingDirectories.filter(
                  (entry) => entry.workingDirectory !== workingDirectory,
                ),
                { workingDirectory, availability },
              ],
            })),
        ),
      });
    }),
  );
}
