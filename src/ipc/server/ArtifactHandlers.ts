import { Effect, Stream } from "effect";
import * as artifacts from "../../domain/artifacts/artifacts";
import * as artifactState from "../../domain/artifacts/artifactState";
import * as globalArtifacts from "../../domain/artifacts/globalArtifacts";
import * as artifactCommands from "../../domain/artifacts/artifactCommands";
import * as widgetUpdates from "../../domain/widgets/widgetUpdates";
import * as widgetState from "../../domain/widgets/widgetState";
import { ArtifactRuntimeError } from "../../contracts/artifacts/artifact-runtime";
import * as artifactWorkflows from "../../domain/artifacts/artifactWorkflows";

import * as messageBoards from "../../domain/artifacts/messageBoards";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { ArtifactRpc } from "../protocol/ArtifactRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

const runtimeError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof ArtifactRuntimeError
        ? cause
        : new ArtifactRuntimeError({
            operation: "artifact",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
    ),
  );

export const artifactHandlers = ArtifactRpc.of({
  "artifacts.observeWidgetEvents": (input) =>
    Stream.unwrap(
      Effect.map(RendererConnection, ({ connectionId }) =>
        widgetUpdates.events(input, connectionId),
      ),
    ),
  "artifacts.observeWidgetPoll": (input) =>
    Stream.unwrap(
      Effect.map(RendererConnection, ({ connectionId }) => widgetUpdates.poll(input, connectionId)),
    ),
  "artifacts.setGlobal": ({ lineageId, global }) =>
    Effect.gen(function* () {
      const result = yield* artifactWorkflows.setArtifactGlobal(lineageId, global);
      (yield* ClientEvents).broadcast({ type: "artifact-catalog-invalidated", lineageId });
      return result;
    }),
  "artifacts.delete": ({ lineageId }) => runtimeError(globalArtifacts.deleteArtifact(lineageId)),
  "artifacts.runtimeStatus": ({ lineageId }) =>
    runtimeError(globalArtifacts.controlRuntime(lineageId, "status")),
  "artifacts.runtimeStart": ({ lineageId }) =>
    runtimeError(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        globalArtifacts.controlRuntime(lineageId, "start", undefined, connectionId),
      ),
    ),
  "artifacts.runtimePause": ({ lineageId }) =>
    runtimeError(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        globalArtifacts.controlRuntime(lineageId, "pause", undefined, connectionId),
      ),
    ),
  "artifacts.runtimeResume": ({ lineageId }) =>
    runtimeError(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        globalArtifacts.controlRuntime(lineageId, "resume", undefined, connectionId),
      ),
    ),
  "artifacts.runtimeRestart": ({ lineageId }) =>
    runtimeError(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        globalArtifacts.controlRuntime(lineageId, "restart", undefined, connectionId),
      ),
    ),
  "artifacts.callTool": ({ sessionId, ...input }) =>
    runtimeError(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        globalArtifacts.callTool(input, sessionId, connectionId),
      ),
    ),
  "artifacts.cakeCall": ({ lineageId, command, input, sessionId }) =>
    runtimeError(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        artifactCommands.invoke(command, input, {
          artifactId: lineageId,
          windowConnectionId: connectionId,
          ...(sessionId === undefined ? null : { callingSessionId: sessionId }),
        }),
      ),
    ),
  "artifacts.reportViewing": (report) =>
    runtimeError(
      Effect.flatMap(RendererConnection, ({ connectionId }) =>
        globalArtifacts.reportViewing(connectionId, report),
      ),
    ),
  "artifacts.stateRead": ({ attachmentId, ...request }) =>
    attachmentId === undefined
      ? artifactState.read(request)
      : widgetState.read({ ...request, attachmentId }),
  "artifacts.stateReplace": ({ attachmentId, ...request }) =>
    attachmentId === undefined
      ? artifactState.replace(request)
      : widgetState.replace({ ...request, attachmentId }),
  "artifacts.stateUpdate": ({ attachmentId, ...request }) =>
    attachmentId === undefined
      ? artifactState.update(request)
      : widgetState.update({ ...request, attachmentId }),
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
