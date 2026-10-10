import { Effect } from "effect";
import * as interviews from "../../domain/interviews/interviews";
import { InterviewRpc } from "../protocol/InterviewRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const interviewHandlers = InterviewRpc.of({
  "interviews.respond": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      interviews.respond(connectionId, request),
    ),
});
