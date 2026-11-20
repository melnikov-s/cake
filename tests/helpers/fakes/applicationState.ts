import { Effect, Layer, SubscriptionRef } from "effect";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/contracts/application/application-data";
import {
  ApplicationState,
  type ApplicationStateProjection,
} from "../../../src/services/storage/ApplicationState";

type Service = ApplicationState["Service"];

/** In-memory application state: transactions update it without persistence. */
const neutralApplicationState = (
  projection: SubscriptionRef.SubscriptionRef<ApplicationStateProjection>,
): Service => ({
  initialize: () => SubscriptionRef.get(projection).pipe(Effect.map((value) => value.state)),
  current: () => SubscriptionRef.get(projection).pipe(Effect.map((value) => value.state)),
  snapshot: () => SubscriptionRef.getUnsafe(projection).state,
  changes: () => SubscriptionRef.changes(projection),
  transact: (transition) =>
    SubscriptionRef.get(projection).pipe(
      Effect.flatMap((current) =>
        transition(current.state).pipe(
          Effect.tap((state) =>
            SubscriptionRef.set(projection, { revision: current.revision + 1, state }),
          ),
        ),
      ),
    ),
});

export const fakeApplicationState = (
  overrides: Partial<Service> = {},
  initial: ApplicationStateValue = defaultApplicationState(),
) =>
  Layer.effect(
    ApplicationState,
    SubscriptionRef.make<ApplicationStateProjection>({ revision: 0, state: initial }).pipe(
      Effect.map((projection) =>
        ApplicationState.of({ ...neutralApplicationState(projection), ...overrides }),
      ),
    ),
  );
