import { Schema } from "effect";
import {
  WidgetEvent,
  WidgetEventSubscription,
  WidgetPollRequest,
  WidgetUpdate,
} from "../../contracts/widgets/widget-updates";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  BoardBrowseInput,
  BoardDescriptionPage,
  BoardEntry,
  BoardEntryReceipts,
  BoardSequence,
  MessageBoardError,
} from "../../contracts/artifacts/message-board";
import { ArtifactError } from "../../contracts/artifacts/artifact-data";
import { ArtifactRuntimeError } from "../../contracts/artifacts/artifact-runtime";
import {
  ArtifactIdentityInput,
  ArtifactToolCallInput,
  ArtifactCakeCallInput,
  ArtifactSetGlobalInput,
  ArtifactExecutionStatus,
} from "../../contracts/artifacts/global-artifact-control";
import { ArtifactViewingReport } from "../../contracts/artifacts/artifact-viewing";
import { ArtifactLineageSummary } from "../../contracts/artifacts/artifact-lineage";
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

import {
  ArtifactState,
  ArtifactStateReplacement,
  ArtifactStateUpdate,
  ArtifactStateConflict,
  ArtifactStateError,
} from "../../contracts/artifacts/artifact-state";

const ArtifactOperationError = Schema.Union([
  ArtifactStateConflict,
  ArtifactStateError,
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
  Rpc.make("artifacts.observeWidgetEvents", {
    payload: WidgetEventSubscription,
    success: WidgetEvent,
    stream: true,
  }),
  Rpc.make("artifacts.observeWidgetPoll", {
    payload: WidgetPollRequest,
    success: WidgetUpdate,
    stream: true,
  }),
  Rpc.make("artifacts.setGlobal", {
    payload: ArtifactSetGlobalInput,
    success: ArtifactLineageSummary,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.delete", {
    payload: ArtifactIdentityInput,
    success: Schema.Void,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.runtimeStatus", {
    payload: ArtifactIdentityInput,
    success: ArtifactExecutionStatus,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.runtimeStart", {
    payload: ArtifactIdentityInput,
    success: ArtifactExecutionStatus,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.runtimePause", {
    payload: ArtifactIdentityInput,
    success: ArtifactExecutionStatus,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.runtimeResume", {
    payload: ArtifactIdentityInput,
    success: ArtifactExecutionStatus,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.runtimeRestart", {
    payload: ArtifactIdentityInput,
    success: ArtifactExecutionStatus,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.callTool", {
    payload: Schema.Struct({
      ...ArtifactToolCallInput.fields,
      sessionId: Schema.optionalKey(SessionId),
    }),
    success: Schema.Json,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.cakeCall", {
    payload: Schema.Struct({
      ...ArtifactCakeCallInput.fields,
      sessionId: Schema.optionalKey(SessionId),
    }),
    success: Schema.Json,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.reportViewing", {
    payload: ArtifactViewingReport,
    success: Schema.Void,
    error: ArtifactRuntimeError,
  }),
  Rpc.make("artifacts.stateRead", {
    payload: Schema.Struct({
      sessionId: Schema.optionalKey(SessionId),
      attachmentId: Schema.optionalKey(SessionId),
      lineageId: ArtifactLineageId,
    }),
    success: ArtifactState,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.stateReplace", {
    payload: Schema.Struct({
      sessionId: Schema.optionalKey(SessionId),
      attachmentId: Schema.optionalKey(SessionId),
      ...ArtifactStateReplacement.fields,
    }),
    success: ArtifactState,
    error: ArtifactOperationError,
  }),
  Rpc.make("artifacts.stateUpdate", {
    payload: Schema.Struct({
      sessionId: Schema.optionalKey(SessionId),
      attachmentId: Schema.optionalKey(SessionId),
      ...ArtifactStateUpdate.fields,
    }),
    success: ArtifactState,
    error: ArtifactOperationError,
  }),
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
      global: Schema.optionalKey(Schema.Boolean),
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
