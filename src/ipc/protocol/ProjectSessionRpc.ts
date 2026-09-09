import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { CakeChatConfiguration } from "../../domain/cake-chats/cake-chat-data";
import { SessionCatalogUpdate } from "../../domain/application/catalog-data";
import { QueuedConversationMessages, TurnId } from "../../domain/conversations/conversation-data";
import {
  ProjectSessionError,
  ProjectSessionCatalogQuery,
  ProjectSessionPreview,
  ProjectSessionPromptInput,
  ProjectSessionStartInput,
  ProjectSessionTarget,
  ProjectSessionUpdate,
  WorkingDirectoryResolutionResult,
} from "../../domain/project-sessions/project-session-data";
import { SESSION_TITLE_MAX_LENGTH, piSettingUpdateSchema } from "../session-contract";

export const ProjectSessionRpc = RpcGroup.make(
  Rpc.make("projectSessions.observeCatalog", {
    payload: ProjectSessionCatalogQuery,
    success: SessionCatalogUpdate,
    error: ProjectSessionError,
    stream: true,
  }),
  Rpc.make("projectSessions.inspect", {
    payload: ProjectSessionTarget,
    success: ProjectSessionPreview,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.start", {
    payload: ProjectSessionStartInput,
    success: TurnId,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.open", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.observe", {
    payload: ProjectSessionTarget,
    success: ProjectSessionUpdate,
    error: ProjectSessionError,
    stream: true,
  }),
  Rpc.make("projectSessions.prompt", {
    payload: ProjectSessionPromptInput,
    success: TurnId,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.steer", {
    payload: ProjectSessionPromptInput,
    success: TurnId,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.followUp", {
    payload: ProjectSessionPromptInput,
    success: TurnId,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.abort", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.listQueuedMessages", {
    payload: ProjectSessionTarget,
    success: QueuedConversationMessages,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.clearQueue", {
    payload: ProjectSessionTarget,
    success: QueuedConversationMessages,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.cancelSteering", {
    payload: ProjectSessionTarget,
    success: QueuedConversationMessages,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.compact", {
    payload: { ...ProjectSessionTarget.fields, instructions: Schema.optional(Schema.String) },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.editMessage", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      text: ProjectSessionPromptInput.fields.text,
      attachments: ProjectSessionPromptInput.fields.attachments,
      renderUserMessageAsMarkdown: ProjectSessionPromptInput.fields.renderUserMessageAsMarkdown,
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.setUserMessageMarkdown", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      renderAsMarkdown: Schema.Boolean,
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.applyConfiguration", {
    payload: { ...ProjectSessionTarget.fields, configuration: CakeChatConfiguration },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.setModel", {
    payload: { ...ProjectSessionTarget.fields, provider: Schema.String, modelId: Schema.String },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.setThinkingLevel", {
    payload: { ...ProjectSessionTarget.fields, level: CakeChatConfiguration.fields.thinkingLevel },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.setFastMode", {
    payload: { ...ProjectSessionTarget.fields, enabled: Schema.Boolean },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.getChangelog", {
    payload: ProjectSessionTarget,
    success: Schema.String,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.navigate", {
    payload: { ...ProjectSessionTarget.fields, entryId: Schema.String },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.setPiSetting", {
    payload: { ...ProjectSessionTarget.fields, update: piSettingUpdateSchema },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.reload", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.login", {
    payload: {
      ...ProjectSessionTarget.fields,
      provider: Schema.String,
      authType: Schema.Literals(["api_key", "oauth"]),
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.logout", {
    payload: { ...ProjectSessionTarget.fields, provider: Schema.String },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.handoff", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      prompt: Schema.optional(Schema.String),
      destinationWorkingDirectory: Schema.optional(Schema.String),
      resolveSource: Schema.optional(Schema.Boolean),
    },
    success: Schema.Struct({ sessionId: Schema.String }),
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.rename", {
    payload: {
      ...ProjectSessionTarget.fields,
      name: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH),
      ),
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.fork", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      destinationWorkingDirectory: Schema.optional(Schema.String),
      resolveSource: Schema.optional(Schema.Boolean),
    },
    success: Schema.Struct({ sessionId: Schema.String }),
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.resolve", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.resolveWorkingDirectory", {
    payload: { workingDirectory: Schema.String },
    success: WorkingDirectoryResolutionResult,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.restore", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.respondControl", {
    payload: {
      sessionId: ProjectSessionTarget.fields.sessionId,
      controlRequestId: Schema.String.check(Schema.isUUID(4)),
      result: Schema.Json,
    },
    error: ProjectSessionError,
  }),
);
