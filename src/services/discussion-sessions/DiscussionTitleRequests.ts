import { Context, Effect, Layer, Queue, Stream } from "effect";
import type { DiscussionSessionTarget } from "../../contracts/discussion-sessions/discussion-session-data";

export interface DiscussionTitleRequest extends DiscussionSessionTarget {
  readonly firstUserMessage: string;
}

/** Backend-lifetime, ephemeral naming work; admission never waits for the utility model. */
export class DiscussionTitleRequests extends Context.Service<
  DiscussionTitleRequests,
  {
    readonly offer: (request: DiscussionTitleRequest) => Effect.Effect<void>;
    readonly requests: () => Stream.Stream<DiscussionTitleRequest>;
  }
>()("cake/services/discussion-sessions/DiscussionTitleRequests") {
  static readonly layer = Layer.effect(
    DiscussionTitleRequests,
    Effect.gen(function* () {
      const queue = yield* Queue.make<DiscussionTitleRequest>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      return DiscussionTitleRequests.of({
        offer: (request) =>
          Queue.offer(queue, {
            ...request,
            firstUserMessage: request.firstUserMessage.slice(0, 8_000),
          }).pipe(Effect.asVoid),
        requests: () => Stream.fromQueue(queue),
      });
    }),
  );
}
