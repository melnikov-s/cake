import { Effect, Stream } from "effect";
import * as artifacts from "../../domain/artifacts/artifacts";
import * as artifactState from "../../domain/artifacts/artifactState";
import * as messageBoards from "../../domain/artifacts/messageBoards";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { ArtifactRpc } from "../protocol/ArtifactRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const artifactHandlers = ArtifactRpc.of({
  "artifacts.stateRead": (request) => artifactState.read(request),
  "artifacts.stateReplace": (request) => artifactState.replace(request),
  "artifacts.stateUpdate": (request) => artifactState.update(request),
  "artifacts.respond-ui": (request) =>
    Effect.flatMap(RendererConnection, ({ connectionId }) =>
      artifacts.respondUi(connectionId, request),
    ),
  "artifacts.export-artifacts": (request) =>
    Effect.flatMap(RendererConnection, () => artifacts.exportArtifacts(request)),
  "artifacts.catalog": (request) => artifacts.listCatalog(request),
  "artifacts.effective": ({ sessionId }) => artifacts.listEffective(sessionId),
  "artifacts.detail": ({ lineageId }) => artifacts.detail(lineageId),
  "artifacts.boardEntries": ({ lineageId, ...input }) => messageBoards.browse(lineageId, input),
  "artifacts.boardBody": ({ lineageId, sequence }) => messageBoards.browseBody(lineageId, sequence),
  "artifacts.boardReceipts": ({ lineageId, sequence }) =>
    messageBoards.browseReceipts(lineageId, sequence),
  "artifacts.history": (request) => artifacts.history(request),
  "artifacts.readExact": (request) => artifacts.readExact(request),
  "artifacts.referenceMetadata": ({ reference }) => artifacts.referenceMetadata(reference),
  "artifacts.compareText": (request) => artifacts.compareText(request),
  "artifacts.restore": (request) =>
    Effect.gen(function* () {
      const result = yield* artifacts.restore(request);
      (yield* ClientEvents).broadcast({
        type: "artifact-catalog-invalidated",
        lineageId: request.lineageId,
      });
      return result;
    }),
  "artifacts.link": (request) =>
    Effect.gen(function* () {
      const result = yield* artifacts.link(request);
      (yield* ClientEvents).broadcast({
        type: "artifact-catalog-invalidated",
        lineageId: request.lineageId,
      });
      return result;
    }),
  "artifacts.unlink": (request) =>
    Effect.gen(function* () {
      yield* artifacts.unlink(request);
      (yield* ClientEvents).broadcast({
        type: "artifact-catalog-invalidated",
        lineageId: request.lineageId,
      });
    }),
  "artifacts.setSelection": (request) =>
    Effect.gen(function* () {
      const result = yield* artifacts.setSelection(request);
      (yield* ClientEvents).broadcast({
        type: "artifact-catalog-invalidated",
        lineageId: request.lineageId,
      });
      return result;
    }),
  "artifacts.materialize": (request) => artifacts.materialize(request),
  "artifacts.observeEvents": () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* RendererConnection;
        return (yield* ClientEvents).artifacts(connection.connectionId);
      }),
    ),
});
