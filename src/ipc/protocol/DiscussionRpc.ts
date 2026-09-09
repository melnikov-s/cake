import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { DiscussionCatalogUpdate } from "../../domain/application/catalog-data";
import {
  DiscussionSessionAcceptedTurn,
  DiscussionSessionCreateInput,
  DiscussionSessionError,
  DiscussionSessionPromptInput,
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
  DiscussionThread,
} from "../../domain/discussion-sessions/discussion-session-data";

const catalogTarget = {
  workingDirectory: DiscussionSessionTarget.fields.workingDirectory,
  parentSessionId: DiscussionSessionTarget.fields.parentSessionId,
};

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
  Rpc.make("discussionSessions.create", {
    payload: DiscussionSessionCreateInput,
    success: DiscussionThread,
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.observe", {
    payload: DiscussionSessionTarget,
    success: DiscussionSessionUpdate,
    error: DiscussionSessionError,
    stream: true,
  }),
  Rpc.make("discussionSessions.prompt", {
    payload: DiscussionSessionPromptInput,
    success: DiscussionSessionAcceptedTurn,
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.abort", {
    payload: DiscussionSessionTarget,
    error: DiscussionSessionError,
  }),
  Rpc.make("discussionSessions.setResolved", {
    payload: { ...DiscussionSessionTarget.fields, resolved: Schema.Boolean },
    success: DiscussionThread,
    error: DiscussionSessionError,
  }),
);
