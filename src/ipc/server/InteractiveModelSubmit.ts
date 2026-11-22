import { Effect, Option } from "effect";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import {
  interactiveModelPrompt,
  type InteractiveModelInput,
} from "../../domain/conversations/interactiveModelPrompt";
import type { CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { ClientConnections } from "../../services/clients/ClientConnections";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { RendererDocumentLifetime } from "../protocol/RendererConnectionMiddleware";

/** Capture the submitting document once, before any asynchronous launch work. */
export const interactiveModelSubmit = Effect.fn("InteractiveModelSubmit.capture")(function* (
  connectionId: number,
) {
  const document = Option.getOrUndefined(yield* Effect.serviceOption(RendererDocumentLifetime));
  const connections = yield* Effect.serviceOption(ClientConnections);
  const coordinator = yield* Effect.serviceOption(RendererRequestCoordinator);
  return (
    handle: CakeSessionHandle,
    input: InteractiveModelInput,
    delivery?: "prompt" | "steer" | "follow-up",
  ) => {
    if (!handle.antigravitySelected?.()) return Effect.succeed(undefined);
    if (Option.isNone(connections) || Option.isNone(coordinator))
      return Effect.fail(
        new SessionChatError({
          operation: "prompt",
          message: "The desktop permission service is unavailable. Reopen Cake and retry.",
        }),
      );
    return interactiveModelPrompt(handle, input, connectionId, document, delivery).pipe(
      Effect.provideService(ClientConnections, connections.value),
      Effect.provideService(RendererRequestCoordinator, coordinator.value),
    );
  };
});
