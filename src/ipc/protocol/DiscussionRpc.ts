import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { DiscussionCatalogUpdate } from "../../domain/application/catalog-data";
import {
  DiscussionSessionAcceptedTurn,
  DiscussionSessionError,
  DiscussionSessionStartInput,
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
  DiscussionThread,
  SessionAssistantEnsureInput,
  SessionAssistantEnsured,
} from "../../domain/discussion-sessions/discussion-session-data";

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
  Rpc.make("discussionSessions.ensureSessionAssistant", {
    payload: SessionAssistantEnsureInput,
    success: SessionAssistantEnsured,
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.setResolved", {
    payload: { ...DiscussionSessionTarget.fields, resolved: Schema.Boolean },
    success: DiscussionThread,
    error: DiscussionSessionError,
  }),
);
