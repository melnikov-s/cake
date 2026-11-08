import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { DiscussionCatalogUpdate } from "../../contracts/application/catalog-data";
import {
  DiscussionSessionAcceptedTurn,
  DiscussionSessionError,
  DiscussionSessionMergeResult,
  DiscussionSessionStartInput,
  DiscussionSessionTarget,
  DiscussionSessionReference,
  DiscussionSessionUpdate,
  DiscussionThread,
  DiscussionThreadMetadata,
} from "../../contracts/discussion-sessions/discussion-session-data";

const catalogTarget = {
  workingDirectory: DiscussionSessionTarget.fields.workingDirectory,
  parentSessionId: DiscussionSessionTarget.fields.parentSessionId,
};

/**
 * Cake-owned Discussion Session lifecycle and metadata. Conversation behavior
 * (prompting, queueing, stopping, configuration) is the shared `sessionChats`
 * group addressed by the sidecar's Pi Session ID.
 */
export const DiscussionRpc = RpcGroup.make(
  Rpc.make("discussionSessions.lookup", {
    payload: { sessionId: DiscussionSessionReference.fields.sessionId },
    success: DiscussionSessionReference,
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.observeMetadata", {
    payload: catalogTarget,
    success: Schema.Array(DiscussionThreadMetadata),
    error: DiscussionSessionError,
    stream: true,
  }),
  Rpc.make("discussionSessions.observeCatalog", {
    payload: catalogTarget,
    success: DiscussionCatalogUpdate,
    error: DiscussionSessionError,
    stream: true,
  }),
  Rpc.make("discussionSessions.list", {
    payload: catalogTarget,
    success: Schema.Array(DiscussionThread),
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.observe", {
    payload: DiscussionSessionTarget,
    success: DiscussionSessionUpdate,
    error: DiscussionSessionError,
    stream: true,
  }),
  Rpc.make("discussionSessions.start", {
    payload: DiscussionSessionStartInput,
    success: DiscussionSessionAcceptedTurn,
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.merge", {
    payload: DiscussionSessionTarget,
    success: DiscussionSessionMergeResult,
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.setResolved", {
    payload: { ...DiscussionSessionTarget.fields, resolved: Schema.Boolean },
    success: DiscussionThread,
    error: DiscussionSessionError,
  }),
);
