import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  QueuedConversationMessages,
  SessionChatConfiguration,
  SessionChatError,
  SessionChatPromptInput,
  SessionChatTarget,
  TurnId,
} from "../../domain/conversations/conversation-data";

/** Conversation behavior shared by every primary Project Session and Cake Chat. */
export const SessionChatRpc = RpcGroup.make(
  Rpc.make("sessionChats.prompt", {
    payload: SessionChatPromptInput,
    success: TurnId,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.steer", {
    payload: SessionChatPromptInput,
    success: TurnId,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.followUp", {
    payload: SessionChatPromptInput,
    success: TurnId,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.abort", { payload: SessionChatTarget, error: SessionChatError }),
  Rpc.make("sessionChats.listQueuedMessages", {
    payload: SessionChatTarget,
    success: QueuedConversationMessages,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.clearQueue", {
    payload: SessionChatTarget,
    success: QueuedConversationMessages,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.cancelSteering", {
    payload: SessionChatTarget,
    success: QueuedConversationMessages,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.removeQueuedMessage", {
    payload: { ...SessionChatTarget.fields, partId: Schema.String },
    success: QueuedConversationMessages,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.steerQueuedMessage", {
    payload: { ...SessionChatTarget.fields, partId: Schema.String },
    success: QueuedConversationMessages,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.sendQueuedMessageNow", {
    payload: { ...SessionChatTarget.fields, partId: Schema.optionalKey(Schema.String) },
    success: QueuedConversationMessages,
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.compact", {
    payload: { ...SessionChatTarget.fields, instructions: Schema.optional(Schema.String) },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.editMessage", {
    payload: { ...SessionChatPromptInput.fields, entryId: Schema.String },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.setUserMessageMarkdown", {
    payload: {
      ...SessionChatTarget.fields,
      entryId: Schema.String,
      renderAsMarkdown: Schema.Boolean,
    },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.applyConfiguration", {
    payload: { ...SessionChatTarget.fields, configuration: SessionChatConfiguration },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.setModel", {
    payload: { ...SessionChatTarget.fields, provider: Schema.String, modelId: Schema.String },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.setThinkingLevel", {
    payload: { ...SessionChatTarget.fields, level: SessionChatConfiguration.fields.thinkingLevel },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.setFastMode", {
    payload: { ...SessionChatTarget.fields, enabled: Schema.Boolean },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.login", {
    payload: {
      ...SessionChatTarget.fields,
      provider: Schema.String,
      authType: Schema.Literals(["api_key", "oauth"]),
    },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.logout", {
    payload: { ...SessionChatTarget.fields, provider: Schema.String },
    error: SessionChatError,
  }),
);
