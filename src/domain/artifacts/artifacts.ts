import { Effect } from "effect";
import type { cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ArtifactError } from "./artifact-data";
import * as artifactWorkflows from "./artifactWorkflows";

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
  const coordinator = yield* RendererRequestCoordinator;
  yield* coordinator.respondUi(connectionId, request.sessionId, request).pipe(asError("respondUi"));
  return { uiRequestId: request.uiRequestId };
});

export const exportArtifacts = Effect.fn("Artifacts.export")(function* (request: ExportArtifacts) {
  yield* authorizedWorkingDirectory(request.sessionId);
  const artifacts = yield* artifactWorkflows
    .listEffectiveSessionArtifacts(request.sessionId)
    .pipe(asError("export"));
  const markdown = artifacts
    .map(
      ({ revision: { snapshot } }) =>
        `## ${snapshot.title ?? snapshot.id}\n\n${snapshot.fallback.markdown}`,
    )
    .join("\n\n---\n\n");
  return { markdown };
});

export const deleteSession = Effect.fn("Artifacts.deleteSession")(function* (
  _workingDirectory: string,
  sessionId: string,
) {
  yield* artifactWorkflows.removeSessionLinks(sessionId).pipe(asError("deleteSession"));
});

export const deleteFamily = Effect.fn("Artifacts.deleteFamily")(function* (familyId: string) {
  yield* artifactWorkflows.removeFamilyLinks(familyId).pipe(asError("deleteFamily"));
});
