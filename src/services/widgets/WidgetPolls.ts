import { Context, Effect, Equal, Hash, Layer, RcMap, Schedule, Stream } from "effect";
import type { WidgetUpdate } from "../../contracts/widgets/widget-updates";

class PollRequest implements Equal.Equal {
  constructor(
    readonly key: string,
    readonly intervalMs: number,
    readonly read: Effect.Effect<WidgetUpdate>,
  ) {}
  [Hash.symbol]() {
    return Hash.string(this.key);
  }
  [Equal.symbol](other: Equal.Equal): boolean {
    return other instanceof PollRequest && other.key === this.key;
  }
}

/** Backend-owned, reference-counted polling. The last RPC consumer releases the loop. */
export class WidgetPolls extends Context.Service<
  WidgetPolls,
  {
    readonly observe: (
      key: string,
      intervalMs: number,
      read: Effect.Effect<WidgetUpdate>,
    ) => Stream.Stream<WidgetUpdate>;
  }
>()("cake/services/widgets/WidgetPolls") {
  static readonly layer = Layer.effect(
    WidgetPolls,
    Effect.gen(function* () {
      const polls = yield* RcMap.make({
        lookup: (request: PollRequest) =>
          Stream.share(
            Stream.fromEffectSchedule(request.read, Schedule.spaced(request.intervalMs)),
            { capacity: 1, strategy: "sliding", replay: 1 },
          ),
      });
      return WidgetPolls.of({
        observe: (key, intervalMs, read) =>
          Stream.unwrap(RcMap.get(polls, new PollRequest(key, intervalMs, read))),
      });
    }),
  );
}
