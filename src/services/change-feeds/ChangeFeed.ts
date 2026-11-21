import type { Scope } from "effect";
import { Effect, PubSub, Stream } from "effect";

/**
 * Replaces the change notices a subscriber missed while it was not reading. The subscriber
 * must re-read its authoritative state; no notice before this point needs replaying.
 */
export interface ChangeFeedResync {
  readonly _tag: "Resync";
}
export const changeFeedResync: ChangeFeedResync = { _tag: "Resync" };
/** Feeds emit this one value, so identity distinguishes it from any published value. */
export const isChangeFeedResync = <A>(item: A | ChangeFeedResync): item is ChangeFeedResync =>
  item === changeFeedResync;

interface Envelope<A> {
  readonly sequence: number;
  readonly value: A;
}

/** A subscriber's position: the newest notice seen, and the newest its pending resync covers. */
interface Cursor {
  readonly last: number;
  readonly coveredThrough: number;
}

interface ChangeFeed<A> {
  /** Never waits for a subscriber: a full buffer drops its oldest notice instead. */
  readonly publish: (value: A) => Effect.Effect<void>;
  /**
   * Subscribes in the caller's Scope before returning, so changes published from now on
   * are not missed. A subscriber that fell behind gets one resync in place of its backlog.
   */
  readonly subscribe: () => Effect.Effect<Stream.Stream<A | ChangeFeedResync>, never, Scope.Scope>;
}

/**
 * Change notices for subscribers that re-read state, not a lossless event log. Publishers
 * often hold a lock, so a stalled subscriber must cost only its own resync, never a wait.
 * Effect's sliding PubSub drops silently; sequence numbers make that drop detectable.
 */
export const makeChangeFeed = Effect.fnUntraced(function* <A>(options: {
  readonly name: string;
  readonly capacity: number;
}) {
  const changes = yield* Effect.acquireRelease(
    PubSub.sliding<Envelope<A>>(options.capacity),
    PubSub.shutdown,
  );
  let sequence = 0;
  let lagging = false;
  const publish = Effect.fnUntraced(function* (value: A) {
    // Numbering and the common, non-full publish happen in one synchronous step.
    const envelope = { sequence: ++sequence, value };
    if (PubSub.publishUnsafe(changes, envelope)) {
      lagging = false;
      return;
    }
    if (PubSub.isShutdownUnsafe(changes)) return;
    // Full: the slowest subscriber has stopped reading. Sliding drops its oldest notice.
    yield* PubSub.publish(changes, envelope);
    if (lagging) return;
    lagging = true;
    yield* Effect.logWarning("Change feed subscriber fell behind; it will resync", {
      feed: options.name,
      subscribers: changes.subscribers.size,
      capacity: options.capacity,
    });
  });
  const subscribe = Effect.fnUntraced(function* (): Effect.fn.Return<
    Stream.Stream<A | ChangeFeedResync>,
    never,
    Scope.Scope
  > {
    const subscription = yield* PubSub.subscribe(changes);
    // Every notice numbered after this point is in the subscription unless dropped.
    const subscribedAt = sequence;
    return Stream.fromSubscription(subscription).pipe(
      Stream.mapAccum<Cursor, Envelope<A>, A | ChangeFeedResync>(
        () => ({ last: subscribedAt, coveredThrough: 0 }),
        (state, envelope) => {
          const last = Math.max(state.last, envelope.sequence);
          // The pending resync re-reads state after everything published so far.
          if (envelope.sequence <= state.coveredThrough) return [{ ...state, last }, []];
          if (envelope.sequence > state.last + 1)
            return [{ last, coveredThrough: sequence }, [changeFeedResync]];
          return [{ ...state, last }, [envelope.value]];
        },
      ),
    );
  });
  return { publish, subscribe } satisfies ChangeFeed<A>;
});
