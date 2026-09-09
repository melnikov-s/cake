import { Effect, Stream } from "effect";
import * as artifacts from "../../domain/artifacts/artifacts";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { ArtifactRpc } from "../protocol/ArtifactRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const artifactHandlers = ArtifactRpc.of({
  "artifacts.respond-artifact": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      artifacts.respond(connectionId, request),
    ),
  "artifacts.respond-ui": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      artifacts.respondUi(connectionId, request),
    ),
  "artifacts.export-artifacts": (request) =>
    Effect.flatMap(RendererConnection, () => artifacts.exportArtifacts(request)),
  "artifacts.observeEvents": () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* RendererConnection;
        return (yield* NativeEvents).artifacts(connection.connectionId);
      }),
    ),
});
