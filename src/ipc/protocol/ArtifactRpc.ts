import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ArtifactError } from "../../domain/artifacts/artifact-data";
import {
  ArtifactLineageDetail,
  ArtifactLineageId,
  ArtifactLineagePage,
  ArtifactLink,
  ArtifactLinkSelection,
  ArtifactLinkTarget,
  ArtifactRevision,
  ArtifactRevisionNumber,
  ArtifactRevisionPage,
  ArtifactReferenceMetadata,
  ArtifactStableRef,
  ArtifactTextComparison,
  EffectiveArtifactProjection,
} from "../../domain/artifacts/artifact-lineage";
import { ArtifactNotFound, ArtifactNotLinked } from "../../domain/artifacts/artifactWorkflows";
import {
  ArtifactProjectionError,
  ArtifactProjectionMetadata,
} from "../../services/artifacts/ArtifactProjection";
import {
  ArtifactPublicationConflict,
  ArtifactStorageError,
} from "../../services/storage/ArtifactStorage";
import { SessionFamilyStorageError } from "../../services/storage/SessionFamilyStorage";
import {
  artifactEventSchema,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../cake-rpc-contract";

const ArtifactOperationError = Schema.Union([
  ArtifactError,
  ArtifactNotFound,
  ArtifactNotLinked,
  ArtifactStorageError,
  ArtifactPublicationConflict,
  ArtifactProjectionError,
  SessionFamilyStorageError,
]);

const SessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Pagination = {
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
};
const LinkMutation = Schema.Struct({
  sessionId: SessionId,
  lineageId: ArtifactLineageId,
  target: ArtifactLinkTarget,
});

export const ArtifactRpc = RpcGroup.make(
  Rpc.make("artifacts.respond-artifact", {
    payload: cakeRpcPayloadSchemas["respond-artifact"],
    success: cakeRpcSuccessSchemas["respond-artifact"],
    error: ArtifactError,
  }),
  Rpc.make("artifacts.respond-ui", {
    payload: cakeRpcPayloadSchemas["respond-ui"],
    success: cakeRpcSuccessSchemas["respond-ui"],
    error: ArtifactError,
  }),
  Rpc.make("artifacts.export-artifacts", {
    payload: cakeRpcPayloadSchemas["export-artifacts"],
    success: cakeRpcSuccessSchemas["export-artifacts"],
    error: ArtifactError,
  }),
  Rpc.make("artifacts.catalog", {
    payload: Schema.Struct({
      search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
      ...Pagination,
    }),
    success: ArtifactLineagePage,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.effective", {
    payload: Schema.Struct({ sessionId: SessionId }),
    success: Schema.Array(EffectiveArtifactProjection),
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.detail", {
    payload: Schema.Struct({ lineageId: ArtifactLineageId }),
    success: ArtifactLineageDetail,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.history", {
    payload: Schema.Struct({ lineageId: ArtifactLineageId, ...Pagination }),
    success: ArtifactRevisionPage,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.readExact", {
    payload: Schema.Struct({
      lineageId: ArtifactLineageId,
      revision: ArtifactRevisionNumber,
    }),
    success: ArtifactRevision,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.referenceMetadata", {
    payload: Schema.Struct({ reference: ArtifactStableRef }),
    success: ArtifactReferenceMetadata,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.compareText", {
    payload: Schema.Struct({
      lineageId: ArtifactLineageId,
      fromRevision: ArtifactRevisionNumber,
      toRevision: ArtifactRevisionNumber,
    }),
    success: ArtifactTextComparison,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.restore", {
    payload: Schema.Struct({
      sessionId: SessionId,
      lineageId: ArtifactLineageId,
      sourceRevision: ArtifactRevisionNumber,
      expectedLatestRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    success: ArtifactRevision,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.link", {
    payload: Schema.Struct({
      ...LinkMutation.fields,
      selection: ArtifactLinkSelection,
    }),
    success: ArtifactLink,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.unlink", {
    payload: LinkMutation,
    success: Schema.Void,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.setSelection", {
    payload: Schema.Struct({
      ...LinkMutation.fields,
      selection: ArtifactLinkSelection,
    }),
    success: ArtifactLink,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.materialize", {
    payload: Schema.Struct({
      sessionId: SessionId,
      lineageId: ArtifactLineageId,
      revision: ArtifactRevisionNumber,
    }),
    success: ArtifactProjectionMetadata,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.observeEvents", { success: artifactEventSchema, stream: true }),
);
