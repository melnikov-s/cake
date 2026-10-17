import { Clock, Context, Effect, Layer, Ref } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";

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
    readonly setComposing: (composing: boolean, sessionId?: string) => Effect.Effect<void>;
    /** True while the composer has unsent text, up to the hold timeout. */
    readonly holdsInterrupts: (sessionId?: string) => Effect.Effect<boolean>;
  }
>()("cake/services/session-catalogs/CakeChatComposerPresence") {
  static readonly layer = Layer.effect(
    CakeChatComposerPresence,
    Effect.gen(function* () {
      const composingSince = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      return CakeChatComposerPresence.of({
        setComposing: Effect.fn("CakeChatComposerPresence.setComposing")(function* (
          composing,
          sessionId = CAKE_CHAT_SESSION_ID,
        ) {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(composingSince, (current) => {
            const next = new Map(current);
            if (composing) next.set(sessionId, now);
            else next.delete(sessionId);
            return next;
          });
        }),
        holdsInterrupts: Effect.fn("CakeChatComposerPresence.holdsInterrupts")(function* (
          sessionId = CAKE_CHAT_SESSION_ID,
        ) {
          const since = (yield* Ref.get(composingSince)).get(sessionId);
          if (since === undefined) return false;
          return (yield* Clock.currentTimeMillis) - since < CAKE_CHAT_COMPOSING_HOLD_MS;
        }),
      });
    }),
  );
}
