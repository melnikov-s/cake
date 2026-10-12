import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  BoardBrowseInput,
  BoardDescriptionPage,
  BoardEntry,
  BoardEntryReceipts,
  BoardSequence,
  MessageBoardError,
} from "../../contracts/artifacts/message-board";
import { ArtifactError } from "../../contracts/artifacts/artifact-data";
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
} from "../../contracts/artifacts/artifact-lineage";
import {
  ArtifactNotFound,
  ArtifactNotLinked,
} from "../../contracts/artifacts/artifact-workflow-errors";
import {
  ArtifactProjectionError,
  ArtifactProjectionMetadata,
} from "../../contracts/artifacts/artifact-projection-data";
import {
  ArtifactPublicationConflict,
  ArtifactStorageError,
} from "../../contracts/storage/artifact-storage-errors";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import {
  artifactEventSchema,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";

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
  Rpc.make("artifacts.boardEntries", {
    payload: Schema.Struct({ lineageId: ArtifactLineageId, ...BoardBrowseInput.fields }),
    success: BoardDescriptionPage,
    error: Schema.Union([MessageBoardError, ArtifactStorageError]),
  }),
  Rpc.make("artifacts.boardBody", {
    payload: Schema.Struct({ lineageId: ArtifactLineageId, sequence: BoardSequence }),
    success: BoardEntry,
    error: Schema.Union([MessageBoardError, ArtifactStorageError]),
  }),
  Rpc.make("artifacts.boardReceipts", {
    payload: Schema.Struct({ lineageId: ArtifactLineageId, sequence: BoardSequence }),
    success: BoardEntryReceipts,
    error: Schema.Union([MessageBoardError, ArtifactStorageError, SessionFamilyStorageError]),
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
