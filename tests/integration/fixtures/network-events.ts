import { Effect, Fiber, Queue, Stream } from "effect";
import { expect } from "vitest";
import type { CakeEvent } from "../../../src/contracts/application/cake-rpc-contract";

/** Propagate stream encoding/transport failures instead of waiting for an event forever. */
export const observeNetworkEvents = Effect.fn("NetworkTest.observeEvents")(function* <E>(
  stream: Stream.Stream<CakeEvent, E>,
) {
  const events = yield* Queue.unbounded<CakeEvent>();
  const fiber = yield* stream.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const next = () =>
    Queue.take(events).pipe(
      Effect.raceFirst(
        Fiber.join(fiber).pipe(Effect.andThen(Effect.die("Event stream ended before next event"))),
      ),
    );
  expect((yield* next()).type).toBe("renderer-events-ready");
  return { events, fiber, next };
});
