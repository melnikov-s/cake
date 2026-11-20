import { Effect, Layer } from "effect";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";

type Service = ClientEvents["Service"];

/** A private real event hub with no subscribers; overrides replace individual methods.
 * Layer.fresh keeps it from sharing a memoized hub with a test's own ClientEventsLive. */
export const fakeClientEvents = (overrides: Partial<Service> = {}) =>
  Layer.effect(
    ClientEvents,
    Effect.map(ClientEvents, (events) => ClientEvents.of({ ...events, ...overrides })),
  ).pipe(Layer.provide(Layer.fresh(ClientEventsLive)));
