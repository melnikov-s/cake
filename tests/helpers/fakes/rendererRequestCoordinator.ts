import { Effect, Layer } from "effect";
import { ClientConnectionsLive } from "../../../src/services/clients/ClientConnections";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../src/services/renderer-requests/RendererRequestCoordinator";

type Service = RendererRequestCoordinator["Service"];

/** A private real coordinator with no connected renderer; overrides replace methods.
 * Layer.fresh keeps it from sharing memoized Live layers with a test's own coordinator. */
export const fakeRendererRequestCoordinator = (overrides: Partial<Service> = {}) =>
  Layer.effect(
    RendererRequestCoordinator,
    Effect.map(RendererRequestCoordinator, (coordinator) =>
      RendererRequestCoordinator.of({ ...coordinator, ...overrides }),
    ),
  ).pipe(
    Layer.provide(
      Layer.fresh(RendererRequestCoordinatorLive).pipe(
        Layer.provide(
          Layer.merge(Layer.fresh(ClientEventsLive), Layer.fresh(ClientConnectionsLive)),
        ),
      ),
    ),
  );
