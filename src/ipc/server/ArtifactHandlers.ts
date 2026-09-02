import { Effect, Stream } from "effect";
import * as artifacts from "../../domain/artifacts";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { ArtifactRpc } from "../protocol/ArtifactRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const artifactHandlers = ArtifactRpc.of({
  "artifacts.respond-artifact": (request) =>
    Effect.flatMap(RendererConnection, () => artifacts.respond(request)),
  "artifacts.respond-ui": (request) =>
    Effect.flatMap(RendererConnection, () => artifacts.respondUi(request)),
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
