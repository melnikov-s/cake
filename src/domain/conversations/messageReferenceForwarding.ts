import { Effect, Schema } from "effect";
import {
  MessageListResult,
  messageNavigationTarget,
  messageRefsSchema,
} from "../../contracts/conversations/message-reference";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import { acquireTarget } from "../project-sessions/projectSessionOperations";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import { jsonObjectSchema, type JsonValue } from "../../contracts/serialization/json-contract";

export const describeMessageReferences = Effect.fn("MessageReferences.describeForwarded")(
  function* (references: readonly string[]) {
    const refs = yield* Schema.decodeUnknownEffect(messageRefsSchema)(references);
    return yield* Effect.forEach(refs, (ref) =>
      Effect.gen(function* () {
        const target = messageNavigationTarget(ref);
        const handle =
          target.sessionId === CAKE_CHAT_SESSION_ID
            ? yield* (yield* CakeSessionRuntimes).acquireSession(target.sessionId)
            : yield* acquireTarget(
                yield* findLocation({ sessionId: target.sessionId }),
                target.sessionId,
                false,
              );
        const page = yield* Schema.decodeUnknownEffect(MessageListResult)(
          yield* handle.inspectSession({
            kind: "messages-list",
            branch: "all",
            entryId: target.messageId,
            limit: 1,
          }),
        );
        const metadata = page.messages.find((message) => message.entryId === target.messageId);
        if (!metadata)
          return yield* new SessionChatError({
            operation: "messages.forward",
            message: "The referenced Pi message does not exist",
          });
        return metadata;
      }),
    );
  },
);

/** Forwarding validates selected identities against Pi metadata, without opening message bodies. */
export const validateMessageReferenceControl = Effect.fn("MessageReferences.validateForward")(
  function* (invocation: { readonly name: string; readonly arguments: JsonValue }) {
    if (invocation.name !== "sessions.create" && invocation.name !== "sessions.send") return;
    const args = yield* Schema.decodeUnknownEffect(jsonObjectSchema)(invocation.arguments);
    const selected = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ messageRefs: Schema.optionalKey(messageRefsSchema) }),
    )(args);
    if (selected.messageRefs?.length) yield* describeMessageReferences(selected.messageRefs);
  },
);
