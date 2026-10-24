import { Effect } from "effect";
import { InterviewError, type InterviewResponse } from "../../contracts/interviews/interview";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

export const respond = Effect.fn("Interviews.respond")(
  function* (connectionId: number, request: InterviewResponse) {
    // Completing an already-dispatched request grants no filesystem authority.
    // The coordinator validates its captured recipient and exact correlation.
    yield* (yield* RendererRequestCoordinator).respondInterview(
      connectionId,
      request.sessionId,
      request,
    );
  },
  Effect.mapError((cause) =>
    cause instanceof InterviewError
      ? cause
      : new InterviewError({
          operation: "respond",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
  ),
);
