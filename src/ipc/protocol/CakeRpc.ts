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
import { PrivilegedCapabilityError } from "../../services/privileged/PrivilegedCapabilities";
import {
  privilegedEventSchema,
  privilegedRequestSchemas,
  privilegedSuccessSchemas,
} from "../privileged-contract";
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
    payload: { request: privilegedRequestSchemas["choose-project"] },
    success: privilegedSuccessSchemas["choose-project"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("electron.open-external-url", {
    payload: { request: privilegedRequestSchemas["open-external-url"] },
    success: privilegedSuccessSchemas["open-external-url"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("electron.show-transcript-selection-context-menu", {
    payload: { request: privilegedRequestSchemas["show-transcript-selection-context-menu"] },
    success: privilegedSuccessSchemas["show-transcript-selection-context-menu"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("electron.show-composer-context-menu", {
    payload: { request: privilegedRequestSchemas["show-composer-context-menu"] },
    success: privilegedSuccessSchemas["show-composer-context-menu"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("electron.show-session-context-menu", {
    payload: { request: privilegedRequestSchemas["show-session-context-menu"] },
    success: privilegedSuccessSchemas["show-session-context-menu"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("electron.show-project-context-menu", {
    payload: { request: privilegedRequestSchemas["show-project-context-menu"] },
    success: privilegedSuccessSchemas["show-project-context-menu"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("filesystem.choose-attachments", {
    payload: { request: privilegedRequestSchemas["choose-attachments"] },
    success: privilegedSuccessSchemas["choose-attachments"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("filesystem.suggest-files", {
    payload: { request: privilegedRequestSchemas["suggest-files"] },
    success: privilegedSuccessSchemas["suggest-files"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("filesystem.read-workspace-file", {
    payload: { request: privilegedRequestSchemas["read-workspace-file"] },
    success: privilegedSuccessSchemas["read-workspace-file"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.reword-composer-selection", {
    payload: { request: privilegedRequestSchemas["reword-composer-selection"] },
    success: privilegedSuccessSchemas["reword-composer-selection"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.generate-session-title", {
    payload: { request: privilegedRequestSchemas["generate-session-title"] },
    success: privilegedSuccessSchemas["generate-session-title"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.set-utility-model", {
    payload: { request: privilegedRequestSchemas["set-utility-model"] },
    success: privilegedSuccessSchemas["set-utility-model"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.register-project", {
    payload: { request: privilegedRequestSchemas["register-project"] },
    success: privilegedSuccessSchemas["register-project"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.rename-project", {
    payload: { request: privilegedRequestSchemas["rename-project"] },
    success: privilegedSuccessSchemas["rename-project"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.remove-project", {
    payload: { request: privilegedRequestSchemas["remove-project"] },
    success: privilegedSuccessSchemas["remove-project"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.delete-session", {
    payload: { request: privilegedRequestSchemas["delete-session"] },
    success: privilegedSuccessSchemas["delete-session"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.set-session-unread", {
    payload: { request: privilegedRequestSchemas["set-session-unread"] },
    success: privilegedSuccessSchemas["set-session-unread"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.restart-pi", {
    payload: { request: privilegedRequestSchemas["restart-pi"] },
    success: privilegedSuccessSchemas["restart-pi"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("managedWorktrees.create-worktree", {
    payload: { request: privilegedRequestSchemas["create-worktree"] },
    success: privilegedSuccessSchemas["create-worktree"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("managedWorktrees.get-worktree-status", {
    payload: { request: privilegedRequestSchemas["get-worktree-status"] },
    success: privilegedSuccessSchemas["get-worktree-status"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("managedWorktrees.land-worktree", {
    payload: { request: privilegedRequestSchemas["land-worktree"] },
    success: privilegedSuccessSchemas["land-worktree"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("terminals.open-terminal", {
    payload: { request: privilegedRequestSchemas["open-terminal"] },
    success: privilegedSuccessSchemas["open-terminal"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("terminals.get-terminal-status", {
    payload: { request: privilegedRequestSchemas["get-terminal-status"] },
    success: privilegedSuccessSchemas["get-terminal-status"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.get-embedded-editor-state", {
    payload: { request: privilegedRequestSchemas["get-embedded-editor-state"] },
    success: privilegedSuccessSchemas["get-embedded-editor-state"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.set-vscode-server-path", {
    payload: { request: privilegedRequestSchemas["set-vscode-server-path"] },
    success: privilegedSuccessSchemas["set-vscode-server-path"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("artifacts.respond-artifact", {
    payload: { request: privilegedRequestSchemas["respond-artifact"] },
    success: privilegedSuccessSchemas["respond-artifact"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("artifacts.respond-ui", {
    payload: { request: privilegedRequestSchemas["respond-ui"] },
    success: privilegedSuccessSchemas["respond-ui"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("artifacts.export-artifacts", {
    payload: { request: privilegedRequestSchemas["export-artifacts"] },
    success: privilegedSuccessSchemas["export-artifacts"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.get-customization-state", {
    payload: { request: privilegedRequestSchemas["get-customization-state"] },
    success: privilegedSuccessSchemas["get-customization-state"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.get-plugin-authoring-reference", {
    payload: { request: privilegedRequestSchemas["get-plugin-authoring-reference"] },
    success: privilegedSuccessSchemas["get-plugin-authoring-reference"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.list-plugin-files", {
    payload: { request: privilegedRequestSchemas["list-plugin-files"] },
    success: privilegedSuccessSchemas["list-plugin-files"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.create-plugin", {
    payload: { request: privilegedRequestSchemas["create-plugin"] },
    success: privilegedSuccessSchemas["create-plugin"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.read-plugin-file", {
    payload: { request: privilegedRequestSchemas["read-plugin-file"] },
    success: privilegedSuccessSchemas["read-plugin-file"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.write-plugin-file", {
    payload: { request: privilegedRequestSchemas["write-plugin-file"] },
    success: privilegedSuccessSchemas["write-plugin-file"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.validate-customization", {
    payload: { request: privilegedRequestSchemas["validate-customization"] },
    success: privilegedSuccessSchemas["validate-customization"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.activate-customization", {
    payload: { request: privilegedRequestSchemas["activate-customization"] },
    success: privilegedSuccessSchemas["activate-customization"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.rollback-customization", {
    payload: { request: privilegedRequestSchemas["rollback-customization"] },
    success: privilegedSuccessSchemas["rollback-customization"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.use-factory-customization", {
    payload: { request: privilegedRequestSchemas["use-factory-customization"] },
    success: privilegedSuccessSchemas["use-factory-customization"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.list-plugins", {
    payload: { request: privilegedRequestSchemas["list-plugins"] },
    success: privilegedSuccessSchemas["list-plugins"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.set-plugin-enabled", {
    payload: { request: privilegedRequestSchemas["set-plugin-enabled"] },
    success: privilegedSuccessSchemas["set-plugin-enabled"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.set-active-scene", {
    payload: { request: privilegedRequestSchemas["set-active-scene"] },
    success: privilegedSuccessSchemas["set-active-scene"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.delete-plugin", {
    payload: { request: privilegedRequestSchemas["delete-plugin"] },
    success: privilegedSuccessSchemas["delete-plugin"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.compile-inline-widget", {
    payload: { request: privilegedRequestSchemas["compile-inline-widget"] },
    success: privilegedSuccessSchemas["compile-inline-widget"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.repair-inline-widget", {
    payload: { request: privilegedRequestSchemas["repair-inline-widget"] },
    success: privilegedSuccessSchemas["repair-inline-widget"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.open-plugin-agent", {
    payload: { request: privilegedRequestSchemas["open-plugin-agent"] },
    success: privilegedSuccessSchemas["open-plugin-agent"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.prompt-plugin-agent", {
    payload: { request: privilegedRequestSchemas["prompt-plugin-agent"] },
    success: privilegedSuccessSchemas["prompt-plugin-agent"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.abort-plugin-agent", {
    payload: { request: privilegedRequestSchemas["abort-plugin-agent"] },
    success: privilegedSuccessSchemas["abort-plugin-agent"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.detach-plugin-agent", {
    payload: { request: privilegedRequestSchemas["detach-plugin-agent"] },
    success: privilegedSuccessSchemas["detach-plugin-agent"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.run-plugin-completion", {
    payload: { request: privilegedRequestSchemas["run-plugin-completion"] },
    success: privilegedSuccessSchemas["run-plugin-completion"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.cancel-plugin-completion", {
    payload: { request: privilegedRequestSchemas["cancel-plugin-completion"] },
    success: privilegedSuccessSchemas["cancel-plugin-completion"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.load-plugin-state", {
    payload: { request: privilegedRequestSchemas["load-plugin-state"] },
    success: privilegedSuccessSchemas["load-plugin-state"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.save-plugin-state", {
    payload: { request: privilegedRequestSchemas["save-plugin-state"] },
    success: privilegedSuccessSchemas["save-plugin-state"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.call-plugin-backend", {
    payload: { request: privilegedRequestSchemas["call-plugin-backend"] },
    success: privilegedSuccessSchemas["call-plugin-backend"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.cancel-plugin-backend-call", {
    payload: { request: privilegedRequestSchemas["cancel-plugin-backend-call"] },
    success: privilegedSuccessSchemas["cancel-plugin-backend-call"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.customization-rendered", {
    payload: { request: privilegedRequestSchemas["customization-rendered"] },
    success: privilegedSuccessSchemas["customization-rendered"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("plugins.customization-runtime-failed", {
    payload: { request: privilegedRequestSchemas["customization-runtime-failed"] },
    success: privilegedSuccessSchemas["customization-runtime-failed"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("electron.set-fullscreen-surface-open", {
    payload: { request: privilegedRequestSchemas["set-fullscreen-surface-open"] },
    success: privilegedSuccessSchemas["set-fullscreen-surface-open"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.inspect-workspace", {
    payload: { request: privilegedRequestSchemas["inspect-workspace"] },
    success: privilegedSuccessSchemas["inspect-workspace"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("workspaces.respond-workspace-trust", {
    payload: { request: privilegedRequestSchemas["respond-workspace-trust"] },
    success: privilegedSuccessSchemas["respond-workspace-trust"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("managedWorktrees.discard-worktree", {
    payload: { request: privilegedRequestSchemas["discard-worktree"] },
    success: privilegedSuccessSchemas["discard-worktree"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("terminals.write-terminal", {
    payload: { request: privilegedRequestSchemas["write-terminal"] },
    success: privilegedSuccessSchemas["write-terminal"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("terminals.resize-terminal", {
    payload: { request: privilegedRequestSchemas["resize-terminal"] },
    success: privilegedSuccessSchemas["resize-terminal"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("terminals.close-terminal", {
    payload: { request: privilegedRequestSchemas["close-terminal"] },
    success: privilegedSuccessSchemas["close-terminal"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.install-embedded-editor", {
    payload: { request: privilegedRequestSchemas["install-embedded-editor"] },
    success: privilegedSuccessSchemas["install-embedded-editor"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.open-embedded-editor", {
    payload: { request: privilegedRequestSchemas["open-embedded-editor"] },
    success: privilegedSuccessSchemas["open-embedded-editor"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.update-embedded-editor-bounds", {
    payload: { request: privilegedRequestSchemas["update-embedded-editor-bounds"] },
    success: privilegedSuccessSchemas["update-embedded-editor-bounds"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.reveal-in-embedded-editor", {
    payload: { request: privilegedRequestSchemas["reveal-in-embedded-editor"] },
    success: privilegedSuccessSchemas["reveal-in-embedded-editor"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.open-embedded-editor-source-control", {
    payload: { request: privilegedRequestSchemas["open-embedded-editor-source-control"] },
    success: privilegedSuccessSchemas["open-embedded-editor-source-control"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("vscode.update-embedded-editor-annotations", {
    payload: { request: privilegedRequestSchemas["update-embedded-editor-annotations"] },
    success: privilegedSuccessSchemas["update-embedded-editor-annotations"],
    error: PrivilegedCapabilityError,
  }),
  Rpc.make("privileged.observe", {
    success: Schema.Union([
      privilegedEventSchema,
      Schema.Struct({ type: Schema.Literal("privileged-stream-ready") }),
    ]),
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
