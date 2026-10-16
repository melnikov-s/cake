import { Effect, Schema } from "effect";
import {
  MessageListInput,
  MessageListResult,
  MessageReadInput,
  MessageReadResult,
  messageNavigationTarget,
} from "../../contracts/conversations/message-reference";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import { acquireTarget } from "../project-sessions/projectSessionOperations";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";

const asError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new SessionChatError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

/** Permanent Cake Chat is already assembled by its owning coordinator. */
const acquireMessageTarget = Effect.fn("MessageReferences.acquireTarget")(function* (
  sessionId: string,
) {
  if (sessionId === CAKE_CHAT_SESSION_ID)
    return yield* (yield* CakeSessionRuntimes).acquireSession(sessionId);
  return yield* acquireTarget(yield* findLocation({ sessionId }), sessionId, false);
});

/** Resolve the target through the existing catalog; Pi remains the message authority. */
export const list = Effect.fn("MessageReferences.list")(
  function* (input: MessageListInput) {
    const decoded = yield* Schema.decodeUnknownEffect(MessageListInput)(input);
    const sessionId =
      decoded.sessionId === CAKE_CHAT_SESSION_ID
        ? CAKE_CHAT_SESSION_ID
        : yield* sessionReferences.resolve(decoded.sessionId);
    const handle = yield* acquireMessageTarget(sessionId);
    const value = yield* handle.inspectSession({ ...decoded, kind: "messages-list" });
    return yield* Schema.decodeUnknownEffect(MessageListResult)(value);
  },
  Effect.scoped,
  asError("messages.list"),
);

/** No search or current-context fallback: the source entry must still exist in Pi. */
export const read = Effect.fn("MessageReferences.read")(
  function* (input: MessageReadInput) {
    const decoded = yield* Schema.decodeUnknownEffect(MessageReadInput)(input);
    const target = messageNavigationTarget(decoded.ref);
    const handle = yield* acquireMessageTarget(target.sessionId);
    const value = yield* handle.inspectSession({
      offset: decoded.offset ?? 0,
      maxChars: decoded.maxChars ?? 4_000,
      kind: "messages-read",
      entryId: target.messageId,
    });
    return yield* Schema.decodeUnknownEffect(MessageReadResult)(value);
  },
  Effect.scoped,
  asError("messages.read"),
);
