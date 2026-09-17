import { Effect } from "effect";
import type { cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ArtifactError } from "./artifact-data";
import type {
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevisionNumber,
} from "./artifact-lineage";
import { ArtifactProjection } from "../../services/artifacts/ArtifactProjection";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
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

export const listCatalog = Effect.fn("Artifacts.listCatalog")(function* (input: {
  readonly search?: string;
  readonly offset?: number;
  readonly limit?: number;
}) {
  return yield* artifactWorkflows.searchGlobalLineages(input);
});

export const listEffective = Effect.fn("Artifacts.listEffective")(function* (sessionId: string) {
  yield* authorizedWorkingDirectory(sessionId);
  const values = yield* artifactWorkflows.listEffectiveSessionArtifacts(sessionId);
  return yield* Effect.forEach(
    values,
    Effect.fn("Artifacts.projectEffective")(function* ({ revision, link }) {
      const { lineage } = yield* artifactWorkflows.lineageDetail(revision.lineageId);
      return {
        revision,
        link,
        latestRevision: lineage.latestRevision,
        stableRef: `cake://artifact/${revision.lineageId}`,
        exactRef: `cake://artifact/${revision.lineageId}@r${revision.metadata.revision}`,
      };
    }),
  );
});

export const detail = artifactWorkflows.lineageDetail;
export const history = Effect.fn("Artifacts.historyPage")(
  (input: {
    readonly lineageId: ArtifactLineageId;
    readonly offset?: number;
    readonly limit?: number;
  }) => artifactWorkflows.paginatedHistory(input.lineageId, input.offset, input.limit),
);
export const readExact = Effect.fn("Artifacts.readExact")(
  (input: { readonly lineageId: ArtifactLineageId; readonly revision: ArtifactRevisionNumber }) =>
    artifactWorkflows.readExactRevision(input.lineageId, input.revision),
);
export const referenceMetadata = artifactWorkflows.resolveReferenceMetadata;
export const compareText = Effect.fn("Artifacts.compareText")(
  (input: {
    readonly lineageId: ArtifactLineageId;
    readonly fromRevision: ArtifactRevisionNumber;
    readonly toRevision: ArtifactRevisionNumber;
  }) => artifactWorkflows.compareText(input.lineageId, input.fromRevision, input.toRevision),
);

const authorizeTarget = Effect.fn("Artifacts.authorizeTarget")(function* (
  sessionId: string,
  target: ArtifactLinkTarget,
) {
  yield* authorizedWorkingDirectory(sessionId);
  if (target.type === "session") {
    if (target.sessionId !== sessionId)
      return yield* new ArtifactError({
        operation: "authorize",
        message: "Session target mismatch",
      });
    return;
  }
  const family = yield* (yield* SessionFamilyStorage).familyForMember(sessionId);
  if (!family || family.familyId !== target.familyId)
    return yield* new ArtifactError({
      operation: "authorize",
      message: "Session is not in that family",
    });
});

const findLink = Effect.fn("Artifacts.findLink")(function* (
  lineageId: ArtifactLineageId,
  target: ArtifactLinkTarget,
) {
  const links = yield* artifactWorkflows.listLineageLinks(lineageId);
  const link = links.find((candidate) =>
    target.type === "session"
      ? candidate.target.type === "session" && candidate.target.sessionId === target.sessionId
      : candidate.target.type === "family" && candidate.target.familyId === target.familyId,
  );
  if (!link)
    return yield* new ArtifactError({ operation: "link", message: "Link was not persisted" });
  return link;
});

export const link = Effect.fn("Artifacts.link")(function* (input: {
  readonly sessionId: string;
  readonly lineageId: ArtifactLineageId;
  readonly target: ArtifactLinkTarget;
  readonly selection: ArtifactLink["selection"];
}) {
  yield* authorizeTarget(input.sessionId, input.target);
  if (input.target.type === "session")
    yield* artifactWorkflows.linkSession(input.lineageId, input.target.sessionId, input.selection);
  else yield* artifactWorkflows.linkFamily(input.lineageId, input.target.familyId, input.selection);
  return yield* findLink(input.lineageId, input.target);
});

export const unlink = Effect.fn("Artifacts.unlink")(function* (input: {
  readonly sessionId: string;
  readonly lineageId: ArtifactLineageId;
  readonly target: ArtifactLinkTarget;
}) {
  yield* authorizeTarget(input.sessionId, input.target);
  if (input.target.type === "session")
    yield* artifactWorkflows.unlinkSession(input.lineageId, input.target.sessionId);
  else yield* artifactWorkflows.unlinkFamily(input.lineageId, input.target.familyId);
});

export const setSelection = Effect.fn("Artifacts.setSelection")(function* (input: {
  readonly sessionId: string;
  readonly lineageId: ArtifactLineageId;
  readonly target: ArtifactLinkTarget;
  readonly selection: ArtifactLink["selection"];
}) {
  yield* authorizeTarget(input.sessionId, input.target);
  yield* artifactWorkflows.setSelection(input.lineageId, input.target, input.selection);
  return yield* findLink(input.lineageId, input.target);
});

export const restore = Effect.fn("Artifacts.restoreRevision")(function* (input: {
  readonly sessionId: string;
  readonly lineageId: ArtifactLineageId;
  readonly sourceRevision: ArtifactRevisionNumber;
  readonly expectedLatestRevision: number;
}) {
  const workingDirectory = yield* authorizedWorkingDirectory(input.sessionId);
  return yield* artifactWorkflows.restore({ ...input, workingDirectory });
});

export const materialize = Effect.fn("Artifacts.materialize")(function* (input: {
  readonly sessionId: string;
  readonly lineageId: ArtifactLineageId;
  readonly revision: ArtifactRevisionNumber;
}) {
  yield* authorizedWorkingDirectory(input.sessionId);
  const effective = yield* artifactWorkflows.resolveEffectiveReference(
    input.sessionId,
    `cake://artifact/${input.lineageId}@r${input.revision}`,
  );
  return yield* (yield* ArtifactProjection).materialize({
    sessionId: input.sessionId,
    revision: effective.revision,
    latestRevision: effective.latestRevision,
    linkMode: effective.link.selection.mode,
  });
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
