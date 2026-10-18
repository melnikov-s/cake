import { Effect, Schema } from "effect";
import {
  MessageListInput,
  MessageListResult,
  MessageReadInput,
  MessageReadResult,
  messageNavigationTarget,
} from "../../contracts/conversations/message-reference";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import * as PiMessageHistory from "../../services/pi/PiMessageHistory";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
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

const projectMessageTarget = Effect.fn("MessageReferences.projectTarget")(function* (
  sessionId: string,
) {
  const location = yield* findLocation({ sessionId });
  return {
    sessionId,
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
  };
});

/** Resolve the target through the existing catalog; Pi remains the message authority. */
export const list = Effect.fn("MessageReferences.list")(
  function* (input: MessageListInput) {
    const decoded = yield* Schema.decodeUnknownEffect(MessageListInput)(input);
    const sessionId = isCakeChatSessionId(decoded.sessionId)
      ? decoded.sessionId
      : yield* sessionReferences.resolve(decoded.sessionId);
    const value = isCakeChatSessionId(sessionId)
      ? yield* (yield* (yield* CakeSessionRuntimes).acquireSession(sessionId)).inspectSession({
          ...decoded,
          kind: "messages-list",
        })
      : yield* PiMessageHistory.list(yield* projectMessageTarget(sessionId), decoded);
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
    const query = {
      offset: decoded.offset ?? 0,
      maxChars: decoded.maxChars ?? 4_000,
      entryId: target.messageId,
    };
    const value = isCakeChatSessionId(target.sessionId)
      ? yield* (yield* (yield* CakeSessionRuntimes).acquireSession(
          target.sessionId,
        )).inspectSession({ ...query, kind: "messages-read" })
      : yield* PiMessageHistory.read(yield* projectMessageTarget(target.sessionId), query);
    return yield* Schema.decodeUnknownEffect(MessageReadResult)(value);
  },
  Effect.scoped,
  asError("messages.read"),
);
