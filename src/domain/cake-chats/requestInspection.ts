import { Effect } from "effect";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
import { CakeChatError, CAKE_CHAT_SESSION_ID } from "../../ipc/cake-chat-data";

/** Read-only diagnostics never acquire a runtime or prepare model context. */
export const inspect = Effect.fn("CakeChats.requestInspection")(function* (input: {
  sessionId: string;
  action: "history" | "payload" | "clear";
  id?: string;
}) {
  if (input.sessionId !== CAKE_CHAT_SESSION_ID)
    return yield* new CakeChatError({
      operation: "requestInspection",
      message: "Request inspection is available only for permanent Cake Chat",
    });
  const durable = yield* CakeChatDurable;
  if (input.action === "clear") yield* durable.clearRequestHistory();
  const payload =
    input.action === "payload"
      ? yield* durable
          .requestPayload(input.id ?? "")
          .pipe(
            Effect.mapError(
              (error) => new CakeChatError({ operation: "requestPayload", message: error.message }),
            ),
          )
      : undefined;
  const history = yield* durable.requestHistory();
  return payload ? { history, payload } : { history };
});
