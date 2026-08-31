import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { RendererApplicationState } from "../../domain/application-data";
import {
  DefaultModelPresetNotFoundError,
  DuplicateModelPresetIdError,
  ModelPresetCreateInput,
  ModelPresetLimitError,
  ModelPresetNotFoundError,
  ModelPresetProjection,
  ModelPresetUpdateInput,
  ModelPresetValidationError,
} from "../../domain/modelPresets";
import {
  ProjectSessionCreateInput,
  ProjectSessionError,
  ProjectSessionPreview,
  ProjectSessionPromptInput,
  ProjectSessionSummary,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "../../domain/project-session-data";
import { ConversationSnapshot, TurnId } from "../../domain/conversation-data";
import {
  CakeChatConfiguration,
  CakeChatError,
  CakeChatPreview,
  CakeChatPromptInput,
  CakeChatSummary,
  CakeChatTarget,
  CakeChatUpdate,
} from "../../domain/cake-chat-data";
import {
  DiscussionSessionAcceptedTurn,
  DiscussionSessionCreateInput,
  DiscussionSessionError,
  DiscussionSessionPromptInput,
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
  DiscussionThread,
} from "../../domain/discussion-session-data";
import {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/catalog-data";
import {
  SubagentError,
  SubagentHandleId,
  SubagentParent,
  SubagentUpdate,
} from "../../domain/subagent-data";
import {
  ModelSelection,
  PiModel,
  PiModelCatalogError,
  UnauthenticatedPiModelError,
  UnavailablePiModelError,
  UnknownPiModelError,
  UnsupportedFastModeError,
  UnsupportedThinkingLevelError,
} from "../../services/pi/model-data";
import {
  ApplicationEncodeError,
  ApplicationWriteError,
} from "../../services/storage/ApplicationStorage";
import {
  WindowStateEncodeError,
  WindowStateMalformedDocumentError,
  WindowStateReadError,
  WindowStateUnsupportedVersionError,
  WindowStateWriteError,
} from "../../services/storage/WindowStateStorage";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";

export class FoundationFailure extends Schema.TaggedError<FoundationFailure>()(
  "FoundationFailure",
  {
    message: Schema.String,
  },
) {}

const ModelPresetMutationError = Schema.Union([
  ModelPresetValidationError,
  ModelPresetNotFoundError,
  DefaultModelPresetNotFoundError,
  DuplicateModelPresetIdError,
  ModelPresetLimitError,
  ApplicationEncodeError,
  ApplicationWriteError,
]);

const WindowStateLoadError = Schema.Union([
  WindowStateReadError,
  WindowStateMalformedDocumentError,
  WindowStateUnsupportedVersionError,
  WindowStateEncodeError,
  WindowStateWriteError,
]);

const WindowStateSaveError = Schema.Union([WindowStateEncodeError, WindowStateWriteError]);

const ModelResolutionError = Schema.Union([
  ModelPresetNotFoundError,
  PiModelCatalogError,
  UnknownPiModelError,
  UnauthenticatedPiModelError,
  UnavailablePiModelError,
  UnsupportedThinkingLevelError,
  UnsupportedFastModeError,
]);

export const CakeRpc = RpcGroup.make(
  Rpc.make("application.getHomeDirectory", {
    success: Schema.String,
  }),
  Rpc.make("application.getState", {
    success: RendererApplicationState,
  }),
  Rpc.make("windowState.load", {
    success: Schema.Json,
    error: WindowStateLoadError,
  }),
  Rpc.make("windowState.save", {
    payload: { snapshot: Schema.Json },
    error: WindowStateSaveError,
  }),
  Rpc.make("projects.observeCatalog", {
    success: ProjectCatalogUpdate,
    stream: true,
  }),
  Rpc.make("models.list", {
    success: Schema.Array(PiModel),
    error: PiModelCatalogError,
  }),
  Rpc.make("models.refresh", { error: PiModelCatalogError }),
  Rpc.make("modelPresets.list", {
    success: ModelPresetProjection,
  }),
  Rpc.make("modelPresets.create", {
    payload: ModelPresetCreateInput,
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.update", {
    payload: ModelPresetUpdateInput,
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.remove", {
    payload: { id: Schema.String.check(Schema.isUUID(4)) },
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.setDefault", {
    // The command always carries id; explicit undefined clears the default.
    payload: { id: Schema.optional(Schema.String.check(Schema.isUUID(4))) },
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.resolve", {
    payload: { id: Schema.String.check(Schema.isUUID(4)) },
    success: ModelSelection,
    error: ModelResolutionError,
  }),
  Rpc.make("cakeChats.list", {
    success: Schema.Array(CakeChatSummary),
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.observeCatalog", {
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
  Rpc.make("cakeChats.abort", {
    payload: CakeChatTarget,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.compact", {
    payload: {
      ...CakeChatTarget.fields,
      instructions: Schema.optionalKey(Schema.String),
    },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.editMessage", {
    payload: { ...CakeChatPromptInput.fields, entryId: Schema.String },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.applyConfiguration", {
    payload: { ...CakeChatTarget.fields, configuration: CakeChatConfiguration },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.setModel", {
    payload: {
      ...CakeChatTarget.fields,
      provider: Schema.String,
      modelId: Schema.String,
    },
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
  Rpc.make("cakeChats.rename", {
    payload: { ...CakeChatTarget.fields, name: Schema.String },
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.handoff", {
    payload: {
      ...CakeChatTarget.fields,
      entryId: Schema.String,
      prompt: Schema.optionalKey(Schema.String),
      resolveSource: Schema.optionalKey(Schema.Boolean),
    },
    success: Schema.Struct({
      sessionId: Schema.String,
      turnId: Schema.optionalKey(TurnId),
    }),
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
  Rpc.make("discussionSessions.observeCatalog", {
    payload: {
      workingDirectory: DiscussionSessionTarget.fields.workingDirectory,
      parentSessionId: DiscussionSessionTarget.fields.parentSessionId,
    },
    success: DiscussionCatalogUpdate,
    error: DiscussionSessionError,
    stream: true,
  }),
  Rpc.make("discussionSessions.list", {
    payload: {
      workingDirectory: DiscussionSessionTarget.fields.workingDirectory,
      parentSessionId: DiscussionSessionTarget.fields.parentSessionId,
    },
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
  Rpc.make("projectSessions.list", {
    success: Schema.Array(ProjectSessionSummary),
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.observeCatalog", {
    success: SessionCatalogUpdate,
    error: ProjectSessionError,
    stream: true,
  }),
  Rpc.make("projectSessions.inspect", {
    payload: ProjectSessionTarget,
    success: ProjectSessionPreview,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.create", {
    payload: ProjectSessionCreateInput,
    success: ConversationSnapshot,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.open", {
    payload: ProjectSessionTarget,
    success: ConversationSnapshot,
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
  Rpc.make("projectSessions.compact", {
    payload: {
      ...ProjectSessionTarget.fields,
      instructions: Schema.optionalKey(Schema.String),
    },
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
  Rpc.make("projectSessions.applyConfiguration", {
    payload: {
      ...ProjectSessionTarget.fields,
      configuration: CakeChatConfiguration,
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.setModel", {
    payload: {
      ...ProjectSessionTarget.fields,
      provider: Schema.String,
      modelId: Schema.String,
    },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.setThinkingLevel", {
    payload: {
      ...ProjectSessionTarget.fields,
      level: CakeChatConfiguration.fields.thinkingLevel,
    },
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
    payload: { ...ProjectSessionTarget.fields, update: Schema.Json },
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
      prompt: Schema.optionalKey(Schema.String),
      resolveSource: Schema.optionalKey(Schema.Boolean),
    },
    success: Schema.Struct({ sessionId: Schema.String }),
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.rename", {
    payload: { ...ProjectSessionTarget.fields, name: Schema.String },
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.fork", {
    payload: {
      ...ProjectSessionTarget.fields,
      entryId: Schema.String,
      destinationWorkingDirectory: Schema.optionalKey(Schema.String),
      resolveSource: Schema.optionalKey(Schema.Boolean),
    },
    success: Schema.Struct({ sessionId: Schema.String }),
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.resolve", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("projectSessions.restore", {
    payload: ProjectSessionTarget,
    error: ProjectSessionError,
  }),
  Rpc.make("subagents.observe", {
    payload: SubagentParent,
    success: SubagentUpdate,
    error: SubagentError,
    stream: true,
  }),
  Rpc.make("subagents.steer", {
    payload: {
      ...SubagentParent.fields,
      handleId: SubagentHandleId,
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
    },
    error: SubagentError,
  }),
  Rpc.make("subagents.abort", {
    payload: { ...SubagentParent.fields, handleId: SubagentHandleId },
    error: SubagentError,
  }),
  Rpc.make("subagents.close", {
    payload: { ...SubagentParent.fields, handleId: SubagentHandleId },
    error: SubagentError,
  }),
  Rpc.make("foundation.typedFailure", {
    error: FoundationFailure,
  }),
  Rpc.make("foundation.stream", {
    payload: {
      count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      intervalMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
    },
    success: Schema.Int,
    stream: true,
  }),
  Rpc.make("foundation.delay", {
    payload: {
      durationMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
    },
  }),
  Rpc.make("foundation.activeRequests", {
    success: Schema.Struct({
      delays: Schema.Int,
      streams: Schema.Int,
    }),
  }),
).middleware(RendererConnectionMiddleware);
