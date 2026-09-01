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
  ProjectSessionError,
  ProjectSessionPreview,
  ProjectSessionPromptInput,
  ProjectSessionStartInput,
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
import { NativeCapabilityError } from "../../services/native/NativeCapabilities";
import {
  applicationEventSchema,
  artifactEventSchema,
  embeddedEditorEventSchema,
  pluginEventSchema,
  nativeCommandSchemas,
  nativeCommandSuccessSchemas,
  surfaceEventSchema,
  terminalEventSchema,
} from "../native-contract";
import { piSettingUpdateSchema } from "../session-contract";
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

const NativeEventStreamReady = Schema.Struct({
  type: Schema.Literal("native-stream-ready"),
});

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
      instructions: Schema.optional(Schema.String),
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
      prompt: Schema.optional(Schema.String),
      resolveSource: Schema.optional(Schema.Boolean),
    },
    success: Schema.Struct({
      sessionId: Schema.String,
      turnId: Schema.optional(TurnId),
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
  Rpc.make("projectSessions.start", {
    payload: ProjectSessionStartInput,
    success: TurnId,
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
      instructions: Schema.optional(Schema.String),
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
      resolveSource: Schema.optional(Schema.Boolean),
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
  Rpc.make("electron.choose-project", {
    payload: nativeCommandSchemas["choose-project"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["choose-project"],
    error: NativeCapabilityError,
  }),
  Rpc.make("electron.open-external-url", {
    payload: nativeCommandSchemas["open-external-url"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["open-external-url"],
    error: NativeCapabilityError,
  }),
  Rpc.make("electron.show-transcript-selection-context-menu", {
    payload: nativeCommandSchemas["show-transcript-selection-context-menu"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["show-transcript-selection-context-menu"],
    error: NativeCapabilityError,
  }),
  Rpc.make("electron.show-composer-context-menu", {
    payload: nativeCommandSchemas["show-composer-context-menu"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["show-composer-context-menu"],
    error: NativeCapabilityError,
  }),
  Rpc.make("electron.show-session-context-menu", {
    payload: nativeCommandSchemas["show-session-context-menu"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["show-session-context-menu"],
    error: NativeCapabilityError,
  }),
  Rpc.make("electron.show-project-context-menu", {
    payload: nativeCommandSchemas["show-project-context-menu"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["show-project-context-menu"],
    error: NativeCapabilityError,
  }),
  Rpc.make("filesystem.choose-attachments", {
    payload: nativeCommandSchemas["choose-attachments"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["choose-attachments"],
    error: NativeCapabilityError,
  }),
  Rpc.make("filesystem.suggest-files", {
    payload: nativeCommandSchemas["suggest-files"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["suggest-files"],
    error: NativeCapabilityError,
  }),
  Rpc.make("filesystem.read-workspace-file", {
    payload: nativeCommandSchemas["read-workspace-file"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["read-workspace-file"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.reword-composer-selection", {
    payload: nativeCommandSchemas["reword-composer-selection"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["reword-composer-selection"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.generate-session-title", {
    payload: nativeCommandSchemas["generate-session-title"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["generate-session-title"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.set-utility-model", {
    payload: nativeCommandSchemas["set-utility-model"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["set-utility-model"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.register-project", {
    payload: nativeCommandSchemas["register-project"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["register-project"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.rename-project", {
    payload: nativeCommandSchemas["rename-project"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["rename-project"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.remove-project", {
    payload: nativeCommandSchemas["remove-project"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["remove-project"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.delete-session", {
    payload: nativeCommandSchemas["delete-session"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["delete-session"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.set-session-unread", {
    payload: nativeCommandSchemas["set-session-unread"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["set-session-unread"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.restart-pi", {
    payload: nativeCommandSchemas["restart-pi"].mapFields(({ type: _type, ...fields }) => fields),
    success: nativeCommandSuccessSchemas["restart-pi"],
    error: NativeCapabilityError,
  }),
  Rpc.make("managedWorktrees.create-worktree", {
    payload: nativeCommandSchemas["create-worktree"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["create-worktree"],
    error: NativeCapabilityError,
  }),
  Rpc.make("managedWorktrees.get-worktree-status", {
    payload: nativeCommandSchemas["get-worktree-status"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["get-worktree-status"],
    error: NativeCapabilityError,
  }),
  Rpc.make("managedWorktrees.land-worktree", {
    payload: nativeCommandSchemas["land-worktree"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["land-worktree"],
    error: NativeCapabilityError,
  }),
  Rpc.make("terminals.open-terminal", {
    payload: nativeCommandSchemas["open-terminal"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["open-terminal"],
    error: NativeCapabilityError,
  }),
  Rpc.make("terminals.get-terminal-status", {
    payload: nativeCommandSchemas["get-terminal-status"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["get-terminal-status"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.get-embedded-editor-state", {
    payload: nativeCommandSchemas["get-embedded-editor-state"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["get-embedded-editor-state"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.set-vscode-server-path", {
    payload: nativeCommandSchemas["set-vscode-server-path"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["set-vscode-server-path"],
    error: NativeCapabilityError,
  }),
  Rpc.make("artifacts.respond-artifact", {
    payload: nativeCommandSchemas["respond-artifact"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["respond-artifact"],
    error: NativeCapabilityError,
  }),
  Rpc.make("artifacts.respond-ui", {
    payload: nativeCommandSchemas["respond-ui"].mapFields(({ type: _type, ...fields }) => fields),
    success: nativeCommandSuccessSchemas["respond-ui"],
    error: NativeCapabilityError,
  }),
  Rpc.make("artifacts.export-artifacts", {
    payload: nativeCommandSchemas["export-artifacts"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["export-artifacts"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.get-customization-state", {
    payload: nativeCommandSchemas["get-customization-state"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["get-customization-state"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.get-plugin-authoring-reference", {
    payload: nativeCommandSchemas["get-plugin-authoring-reference"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["get-plugin-authoring-reference"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.list-plugin-files", {
    payload: nativeCommandSchemas["list-plugin-files"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["list-plugin-files"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.create-plugin", {
    payload: nativeCommandSchemas["create-plugin"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["create-plugin"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.read-plugin-file", {
    payload: nativeCommandSchemas["read-plugin-file"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["read-plugin-file"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.write-plugin-file", {
    payload: nativeCommandSchemas["write-plugin-file"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["write-plugin-file"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.validate-customization", {
    payload: nativeCommandSchemas["validate-customization"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["validate-customization"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.activate-customization", {
    payload: nativeCommandSchemas["activate-customization"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["activate-customization"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.rollback-customization", {
    payload: nativeCommandSchemas["rollback-customization"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["rollback-customization"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.use-factory-customization", {
    payload: nativeCommandSchemas["use-factory-customization"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["use-factory-customization"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.list-plugins", {
    payload: nativeCommandSchemas["list-plugins"].mapFields(({ type: _type, ...fields }) => fields),
    success: nativeCommandSuccessSchemas["list-plugins"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.set-plugin-enabled", {
    payload: nativeCommandSchemas["set-plugin-enabled"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["set-plugin-enabled"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.set-active-scene", {
    payload: nativeCommandSchemas["set-active-scene"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["set-active-scene"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.delete-plugin", {
    payload: nativeCommandSchemas["delete-plugin"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["delete-plugin"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.compile-inline-widget", {
    payload: nativeCommandSchemas["compile-inline-widget"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["compile-inline-widget"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.repair-inline-widget", {
    payload: nativeCommandSchemas["repair-inline-widget"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["repair-inline-widget"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.open-plugin-agent", {
    payload: nativeCommandSchemas["open-plugin-agent"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["open-plugin-agent"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.prompt-plugin-agent", {
    payload: nativeCommandSchemas["prompt-plugin-agent"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["prompt-plugin-agent"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.abort-plugin-agent", {
    payload: nativeCommandSchemas["abort-plugin-agent"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["abort-plugin-agent"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.detach-plugin-agent", {
    payload: nativeCommandSchemas["detach-plugin-agent"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["detach-plugin-agent"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.run-plugin-completion", {
    payload: nativeCommandSchemas["run-plugin-completion"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["run-plugin-completion"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.cancel-plugin-completion", {
    payload: nativeCommandSchemas["cancel-plugin-completion"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["cancel-plugin-completion"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.load-plugin-state", {
    payload: nativeCommandSchemas["load-plugin-state"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["load-plugin-state"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.save-plugin-state", {
    payload: nativeCommandSchemas["save-plugin-state"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["save-plugin-state"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.call-plugin-backend", {
    payload: nativeCommandSchemas["call-plugin-backend"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["call-plugin-backend"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.cancel-plugin-backend-call", {
    payload: nativeCommandSchemas["cancel-plugin-backend-call"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["cancel-plugin-backend-call"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.customization-rendered", {
    payload: nativeCommandSchemas["customization-rendered"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["customization-rendered"],
    error: NativeCapabilityError,
  }),
  Rpc.make("plugins.customization-runtime-failed", {
    payload: nativeCommandSchemas["customization-runtime-failed"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["customization-runtime-failed"],
    error: NativeCapabilityError,
  }),
  Rpc.make("electron.set-fullscreen-surface-open", {
    payload: nativeCommandSchemas["set-fullscreen-surface-open"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["set-fullscreen-surface-open"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.inspect-workspace", {
    payload: nativeCommandSchemas["inspect-workspace"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["inspect-workspace"],
    error: NativeCapabilityError,
  }),
  Rpc.make("workspaces.respond-workspace-trust", {
    payload: nativeCommandSchemas["respond-workspace-trust"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["respond-workspace-trust"],
    error: NativeCapabilityError,
  }),
  Rpc.make("managedWorktrees.discard-worktree", {
    payload: nativeCommandSchemas["discard-worktree"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["discard-worktree"],
    error: NativeCapabilityError,
  }),
  Rpc.make("terminals.write-terminal", {
    payload: nativeCommandSchemas["write-terminal"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["write-terminal"],
    error: NativeCapabilityError,
  }),
  Rpc.make("terminals.resize-terminal", {
    payload: nativeCommandSchemas["resize-terminal"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["resize-terminal"],
    error: NativeCapabilityError,
  }),
  Rpc.make("terminals.close-terminal", {
    payload: nativeCommandSchemas["close-terminal"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["close-terminal"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.install-embedded-editor", {
    payload: nativeCommandSchemas["install-embedded-editor"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["install-embedded-editor"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.open-embedded-editor", {
    payload: nativeCommandSchemas["open-embedded-editor"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["open-embedded-editor"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.update-embedded-editor-bounds", {
    payload: nativeCommandSchemas["update-embedded-editor-bounds"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["update-embedded-editor-bounds"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.reveal-in-embedded-editor", {
    payload: nativeCommandSchemas["reveal-in-embedded-editor"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["reveal-in-embedded-editor"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.open-embedded-editor-source-control", {
    payload: nativeCommandSchemas["open-embedded-editor-source-control"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["open-embedded-editor-source-control"],
    error: NativeCapabilityError,
  }),
  Rpc.make("vscode.update-embedded-editor-annotations", {
    payload: nativeCommandSchemas["update-embedded-editor-annotations"].mapFields(
      ({ type: _type, ...fields }) => fields,
    ),
    success: nativeCommandSuccessSchemas["update-embedded-editor-annotations"],
    error: NativeCapabilityError,
  }),
  Rpc.make("application.observeEvents", {
    success: Schema.Union([applicationEventSchema, NativeEventStreamReady]),
    stream: true,
  }),
  Rpc.make("artifacts.observeEvents", {
    success: Schema.Union([artifactEventSchema, NativeEventStreamReady]),
    stream: true,
  }),
  Rpc.make("plugins.observeEvents", {
    success: Schema.Union([pluginEventSchema, NativeEventStreamReady]),
    stream: true,
  }),
  Rpc.make("terminals.observeEvents", {
    success: Schema.Union([terminalEventSchema, NativeEventStreamReady]),
    stream: true,
  }),
  Rpc.make("vscode.observeEvents", {
    success: Schema.Union([embeddedEditorEventSchema, NativeEventStreamReady]),
    stream: true,
  }),
  Rpc.make("electron.observeSurfaceEvents", {
    success: Schema.Union([surfaceEventSchema, NativeEventStreamReady]),
    stream: true,
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
