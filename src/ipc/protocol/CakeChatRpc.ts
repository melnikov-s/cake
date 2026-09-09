import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  CakeChatConfiguration,
  CakeChatCatalogQuery,
  CakeChatError,
  CakeChatPreview,
  CakeChatPromptInput,
  CakeChatTarget,
  CakeChatUpdate,
} from "../../domain/cake-chats/cake-chat-data";
import { CakeChatCatalogUpdate } from "../../domain/application/catalog-data";
import { ConversationSnapshot, TurnId } from "../../domain/conversations/conversation-data";
import { SESSION_TITLE_MAX_LENGTH, piSettingUpdateSchema } from "../session-contract";
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
  Rpc.make("cakeChats.prompt", {
    payload: CakeChatPromptInput,
    success: TurnId,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.abort", { payload: CakeChatTarget, error: CakeChatError }),
  Rpc.make("cakeChats.compact", {
    payload: { ...CakeChatTarget.fields, instructions: Schema.optional(Schema.String) },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.editMessage", {
    payload: { ...CakeChatPromptInput.fields, entryId: Schema.String },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.setUserMessageMarkdown", {
    payload: {
      ...CakeChatTarget.fields,
      entryId: Schema.String,
      renderAsMarkdown: Schema.Boolean,
    },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.applyConfiguration", {
    payload: { ...CakeChatTarget.fields, configuration: CakeChatConfiguration },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.setModel", {
    payload: { ...CakeChatTarget.fields, provider: Schema.String, modelId: Schema.String },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.setThinkingLevel", {
    payload: { ...CakeChatTarget.fields, level: CakeChatConfiguration.fields.thinkingLevel },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.setFastMode", {
    payload: { ...CakeChatTarget.fields, enabled: Schema.Boolean },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.setPiSetting", {
    payload: { ...CakeChatTarget.fields, update: piSettingUpdateSchema },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.reload", { payload: CakeChatTarget, error: CakeChatError }),
  Rpc.make("cakeChats.login", {
    payload: {
      ...CakeChatTarget.fields,
      provider: Schema.String,
      authType: Schema.Literals(["api_key", "oauth"]),
    },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.logout", {
    payload: { ...CakeChatTarget.fields, provider: Schema.String },
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
  Rpc.make("cakeChats.handoff", {
    payload: {
      ...CakeChatTarget.fields,
      entryId: Schema.String,
      prompt: Schema.optional(Schema.String),
      resolveSource: Schema.optional(Schema.Boolean),
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
