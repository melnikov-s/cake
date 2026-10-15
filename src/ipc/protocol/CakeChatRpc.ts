import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  CakeChatCatalogQuery,
  CakeChatError,
  CakeChatPreview,
  CakeChatStartInput,
  CakeChatTarget,
  CakeChatControlUpdate,
} from "../../contracts/cake-chats/cake-chat-data";
import { RequestInspectionResult } from "../../contracts/conversations/request-inspection";
import {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
} from "../../contracts/application/catalog-data";
import {
  CakeChatSideChatStartInput,
  DiscussionSessionAcceptedTurn,
} from "../../contracts/discussion-sessions/discussion-session-data";
import { TurnId } from "../../contracts/conversations/conversation-data";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";

export const CakeChatRpc = RpcGroup.make(
  Rpc.make("cakeChats.requestInspection", {
    payload: {
      sessionId: CakeChatTarget.fields.sessionId,
      action: Schema.Literals(["history", "payload", "clear"]),
      id: Schema.optionalKey(Schema.String),
    },
    success: RequestInspectionResult,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.observeCatalog", {
    payload: CakeChatCatalogQuery,
    success: CakeChatCatalogUpdate,
    error: CakeChatError,
    stream: true,
  }),
  Rpc.make("cakeChats.inspect", {
    payload: { sessionId: CakeChatTarget.fields.sessionId },
    success: CakeChatPreview,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.open", {
    payload: CakeChatTarget,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.observeControls", {
    payload: CakeChatTarget,
    success: CakeChatControlUpdate,
    error: CakeChatError,
    stream: true,
  }),
  Rpc.make("cakeChats.start", {
    payload: CakeChatStartInput,
    success: TurnId,
    error: CakeChatError,
  }),
  /**
   * Side chats are Discussion Sessions branched from Cake Chat messages. Their
   * sidecar conversations and resolution use the shared `discussionSessions`
   * and `sessionChats` operations once they exist.
   */
  Rpc.make("cakeChats.observeSideChats", {
    payload: {},
    success: DiscussionCatalogUpdate,
    error: CakeChatError,
    stream: true,
  }),
  Rpc.make("cakeChats.startSideChat", {
    payload: CakeChatSideChatStartInput,
    success: DiscussionSessionAcceptedTurn,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.setUnread", {
    payload: { unread: Schema.Boolean },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.respondControl", {
    payload: {
      controlRequestId: Schema.String.check(Schema.isUUID(4)),
      result: Schema.Json,
    },
    error: CakeChatError,
  }),
).middleware(RendererConnectionMiddleware);
