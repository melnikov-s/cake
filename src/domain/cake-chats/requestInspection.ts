import { Effect } from "effect";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
import { CakeChatError } from "../../contracts/cake-chats/cake-chat-data";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";

/** Read-only diagnostics never acquire a runtime or prepare model context. */
export const inspect = Effect.fn("CakeChats.requestInspection")(function* (input: {
  sessionId: string;
  action: "history" | "payload" | "clear";
  id?: string;
}) {
  if (!isCakeChatSessionId(input.sessionId))
    return yield* new CakeChatError({
      operation: "requestInspection",
      message: "Request inspection is available only for permanent Cake Chat",
    });
  const durable = yield* CakeChatDurable;
  if (input.action === "clear") yield* durable.clearRequestHistory(input.sessionId);
  const payload =
    input.action === "payload"
      ? yield* durable
          .requestPayload(input.id ?? "", input.sessionId)
          .pipe(
            Effect.mapError(
              (error) => new CakeChatError({ operation: "requestPayload", message: error.message }),
            ),
          )
      : undefined;
  const history = yield* durable.requestHistory(input.sessionId);
  return payload ? { history, payload } : { history };
});
