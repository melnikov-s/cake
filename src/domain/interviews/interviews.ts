import { Effect } from "effect";
import { InterviewError, type InterviewResponse } from "../../contracts/interviews/interview";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";

export const respond = Effect.fn("Interviews.respond")(
  function* (connectionId: number, request: InterviewResponse) {
    const access = yield* ProjectAccess;
    const workingDirectory = yield* access.resolveSessionWorkingDirectory(request.sessionId);
    if (!(yield* access.isAllowed(workingDirectory)))
      return yield* new InterviewError({
        operation: "authorize",
        message: "Project path was not selected by the user",
      });
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
