import { Effect } from "effect";
import type { nativeOperationPayloadSchemas } from "../ipc/native-protocol";
import { ProjectSessionIntegrations } from "../services/pi/ProjectSessionIntegrations";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ArtifactStorage } from "../services/storage/ArtifactStorage";
import { ArtifactError } from "./artifact-data";

type ArtifactResponse = (typeof nativeOperationPayloadSchemas)["respond-artifact"]["Type"];
type UiResponse = (typeof nativeOperationPayloadSchemas)["respond-ui"]["Type"];
type ExportArtifacts = (typeof nativeOperationPayloadSchemas)["export-artifacts"]["Type"];

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

export const respond = Effect.fn("Artifacts.respond")(function* (request: ArtifactResponse) {
  yield* authorizedWorkingDirectory(request.sessionId);
  const runtime = yield* ProjectSessionIntegrations;
  yield* runtime.respondArtifact(request.sessionId, request).pipe(asError("respond"));
  return { artifactRequestId: request.artifactRequestId };
});

export const respondUi = Effect.fn("Artifacts.respondUi")(function* (request: UiResponse) {
  yield* authorizedWorkingDirectory(request.sessionId);
  const runtime = yield* ProjectSessionIntegrations;
  yield* runtime.respondUi(request.sessionId, request).pipe(asError("respondUi"));
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
