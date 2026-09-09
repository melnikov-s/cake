import { Effect } from "effect";
import type { cakeRpcPayloadSchemas } from "../ipc/cake-rpc-contract";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ArtifactStorage } from "../services/storage/ArtifactStorage";
import { ArtifactError } from "./artifact-data";

type ArtifactResponse = (typeof cakeRpcPayloadSchemas)["respond-artifact"]["Type"];
type UiResponse = (typeof cakeRpcPayloadSchemas)["respond-ui"]["Type"];
type ExportArtifacts = (typeof cakeRpcPayloadSchemas)["export-artifacts"]["Type"];

const asError = (operation: string) =>
  Effect.mapError(
    (error: { readonly message: string } | unknown) =>
      new ArtifactError({
        operation,
        message: error instanceof Error ? error.message : String(error),
      }),
  );

const authorizedWorkingDirectory = Effect.fn("Artifacts.authorizedWorkingDirectory")(function* (
  sessionId: string,
) {
  const access = yield* ProjectAccess;
  const workingDirectory = yield* access
    .resolveSessionWorkingDirectory(sessionId)
    .pipe(asError("resolveSessionWorkingDirectory"));
  if (yield* access.isAllowed(workingDirectory)) return workingDirectory;
  return yield* new ArtifactError({
    operation: "authorize",
    message: "Project path was not selected by the user",
  });
});

export const respond = Effect.fn("Artifacts.respond")(function* (
  connectionId: number,
  request: ArtifactResponse,
) {
  yield* authorizedWorkingDirectory(request.sessionId);
  const coordinator = yield* RendererRequestCoordinator;
  yield* coordinator
    .respondArtifact(connectionId, request.sessionId, request)
    .pipe(asError("respond"));
  return { artifactRequestId: request.artifactRequestId };
});

export const respondUi = Effect.fn("Artifacts.respondUi")(function* (
  connectionId: number,
  request: UiResponse,
) {
  yield* authorizedWorkingDirectory(request.sessionId);
  const coordinator = yield* RendererRequestCoordinator;
  yield* coordinator.respondUi(connectionId, request.sessionId, request).pipe(asError("respondUi"));
  return { uiRequestId: request.uiRequestId };
});

export const exportArtifacts = Effect.fn("Artifacts.export")(function* (request: ExportArtifacts) {
  const workingDirectory = yield* authorizedWorkingDirectory(request.sessionId);
  const storage = yield* ArtifactStorage;
  const markdown = yield* storage
    .exportMarkdown(workingDirectory, request.sessionId)
    .pipe(asError("export"));
  return { markdown };
});

export const deleteSession = Effect.fn("Artifacts.deleteSession")(function* (
  workingDirectory: string,
  sessionId: string,
) {
  const storage = yield* ArtifactStorage;
  yield* storage.deleteSession(workingDirectory, sessionId).pipe(asError("deleteSession"));
});
