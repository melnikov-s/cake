import { Clock, Context, Effect, Layer, Ref } from "effect";

/** Unsent text holds interrupt deliveries back for at most this long after it was last reported. */
export const CAKE_CHAT_COMPOSING_HOLD_MS = 2 * 60_000;

/**
 * Process-local, advisory composer presence for the permanent Cake Chat. The renderer reports
 * when its composer gains or loses unsent text; interrupt-policy session results wait while it
 * does, so a report never starts a turn under the user's half-typed message. Nothing durable:
 * a restart simply releases the hold.
 */
export class CakeChatComposerPresence extends Context.Service<
  CakeChatComposerPresence,
  {
    readonly setComposing: (composing: boolean) => Effect.Effect<void>;
    /** True while the composer has unsent text, up to the hold timeout. */
    readonly holdsInterrupts: Effect.Effect<boolean>;
  }
>()("cake/services/session-catalogs/CakeChatComposerPresence") {
  static readonly layer = Layer.effect(
    CakeChatComposerPresence,
    Effect.gen(function* () {
      const composingSince = yield* Ref.make<number | undefined>(undefined);
      return CakeChatComposerPresence.of({
        setComposing: Effect.fn("CakeChatComposerPresence.setComposing")(function* (composing) {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.set(composingSince, composing ? now : undefined);
        }),
        holdsInterrupts: Effect.gen(function* () {
          const since = yield* Ref.get(composingSince);
          if (since === undefined) return false;
          return (yield* Clock.currentTimeMillis) - since < CAKE_CHAT_COMPOSING_HOLD_MS;
        }),
      });
    }),
  );
}
