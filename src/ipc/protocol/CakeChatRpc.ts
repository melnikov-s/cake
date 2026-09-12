import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  CakeChatCatalogQuery,
  CakeChatError,
  CakeChatPreview,
  CakeChatStartInput,
  CakeChatTarget,
  CakeChatUpdate,
} from "../../domain/cake-chats/cake-chat-data";
import { CakeChatCatalogUpdate } from "../../domain/application/catalog-data";
import { ConversationSnapshot, TurnId } from "../../domain/conversations/conversation-data";
import { SESSION_TITLE_MAX_LENGTH } from "../session-contract";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";

export const CakeChatRpc = RpcGroup.make(
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
    success: ConversationSnapshot,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.observe", {
    payload: CakeChatTarget,
    success: CakeChatUpdate,
    error: CakeChatError,
    stream: true,
  }),
  Rpc.make("cakeChats.start", {
    payload: CakeChatStartInput,
    success: TurnId,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.rename", {
    payload: {
      ...CakeChatTarget.fields,
      name: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH),
      ),
    },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.toolCompact", {
    payload: {
      ...CakeChatTarget.fields,
      entryId: Schema.String,
      prompt: Schema.optional(Schema.String),
    },
    success: Schema.Struct({ sessionId: Schema.String, turnId: Schema.optional(TurnId) }),
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.resolve", { payload: CakeChatTarget, error: CakeChatError }),
  Rpc.make("cakeChats.restore", { payload: CakeChatTarget, error: CakeChatError }),
  Rpc.make("cakeChats.deleteResolved", { payload: CakeChatTarget, error: CakeChatError }),
  Rpc.make("cakeChats.respondControl", {
    payload: {
      controlRequestId: Schema.String.check(Schema.isUUID(4)),
      result: Schema.Json,
    },
    error: CakeChatError,
  }),
).middleware(RendererConnectionMiddleware);
