import { Effect } from "effect";
import { ClientConnections } from "../../services/clients/ClientConnections";
import {
  BackendConnectionError,
  BackendConnectionRpc,
  cakeBuildId,
} from "../protocol/BackendConnectionRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
export const backendConnectionHandlers = BackendConnectionRpc.of({
  "backendConnection.connect": ({ buildId }) =>
    Effect.gen(function* () {
      if (buildId !== cakeBuildId)
        return yield* new BackendConnectionError({
          message:
            "Incompatible Cake server. Build the desktop and server from the same source checkout.",
        });
      const { connectionId } = yield* RendererConnection;
      (yield* ClientConnections).remoteDesktop(connectionId);
      return { buildId: cakeBuildId };
    }),
});
