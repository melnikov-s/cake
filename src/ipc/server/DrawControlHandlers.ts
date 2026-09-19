import { Effect } from "effect";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { DrawControlRpc, DrawControlRpcError } from "../protocol/DrawControlRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const drawControlHandlers = DrawControlRpc.of({
  "drawControl.respond": ({ sessionId, drawRequestId, response }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      yield* (yield* RendererRequestCoordinator).respondDrawControl(
        connectionId,
        sessionId,
        drawRequestId,
        response,
      );
    }).pipe(
      Effect.mapError(
        (error) =>
          new DrawControlRpcError({
            message: error.message,
          }),
      ),
    ),
});
