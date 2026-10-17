import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { Effect } from "effect";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { CakeChatError } from "../../contracts/cake-chats/cake-chat-data";
import { cakeChatControlTools } from "../../contracts/application/window-control-definitions";
import { acquireTarget } from "./cakeChatOperations";

/** Reuse an assembled runtime, or reconstruct its ordinary shared configuration after restart. */
export const acquireAvailable = Effect.fn("CakeChats.acquireAvailable")(function* (
  sessionId: string,
) {
  const sessions = yield* CakeSessionRuntimes;
  return yield* sessions
    .acquireSession(sessionId)
    .pipe(
      Effect.catchTag("PiSessionError", (error) =>
        error.operation === "acquireSession" && error.message.includes("has not been assembled")
          ? acquire(sessionId)
          : Effect.fail(new CakeChatError({ operation: error.operation, message: error.message })),
      ),
    );
});

/** Messaging can open a permanent chat without first visiting its renderer surface. */
export const acquire = Effect.fn("CakeChats.acquireAddress")(function* (sessionId: string) {
  const configuration = yield* Effect.serviceOption(CakeChatConfiguration);
  if (configuration._tag === "None")
    return yield* new CakeChatError({
      operation: "acquire",
      message: "Permanent chat configuration is unavailable",
    });
  return yield* acquireTarget(
    { sessionId, tools: cakeChatControlTools() },
    false,
    configuration.value,
  );
});
