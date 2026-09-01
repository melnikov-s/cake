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
import { ElectronError } from "../../services/electron/Electron";
import { ArtifactError } from "../../domain/artifact-data";
import { NativeOperationError } from "./NativeOperationError";
import { ManagedWorktreeError } from "../../services/worktrees/ManagedWorktrees";
import { PluginRuntimeError } from "../../services/plugins/PluginRuntime";
import { TerminalError } from "../../services/terminal/Terminal";
import { VsCodeServerError } from "../../services/vscode/VsCodeServer";
import {
  applicationEventSchema,
  artifactEventSchema,
  embeddedEditorEventSchema,
  pluginEventSchema,
  nativeOperationPayloadSchemas,
  nativeOperationSuccessSchemas,
  surfaceEventSchema,
  terminalEventSchema,
} from "../native-protocol";
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
    payload: nativeOperationPayloadSchemas["choose-project"],
    success: nativeOperationSuccessSchemas["choose-project"],
    error: ElectronError,
  }),
  Rpc.make("electron.open-external-url", {
    payload: nativeOperationPayloadSchemas["open-external-url"],
    success: nativeOperationSuccessSchemas["open-external-url"],
    error: ElectronError,
  }),
  Rpc.make("electron.show-transcript-selection-context-menu", {
    payload: nativeOperationPayloadSchemas["show-transcript-selection-context-menu"],
    success: nativeOperationSuccessSchemas["show-transcript-selection-context-menu"],
    error: ElectronError,
  }),
  Rpc.make("electron.show-composer-context-menu", {
    payload: nativeOperationPayloadSchemas["show-composer-context-menu"],
    success: nativeOperationSuccessSchemas["show-composer-context-menu"],
    error: ElectronError,
  }),
  Rpc.make("electron.show-session-context-menu", {
    payload: nativeOperationPayloadSchemas["show-session-context-menu"],
    success: nativeOperationSuccessSchemas["show-session-context-menu"],
    error: ElectronError,
  }),
  Rpc.make("electron.show-project-context-menu", {
    payload: nativeOperationPayloadSchemas["show-project-context-menu"],
    success: nativeOperationSuccessSchemas["show-project-context-menu"],
    error: ElectronError,
  }),
  Rpc.make("filesystem.choose-attachments", {
    payload: nativeOperationPayloadSchemas["choose-attachments"],
    success: nativeOperationSuccessSchemas["choose-attachments"],
    error: NativeOperationError,
  }),
  Rpc.make("filesystem.suggest-files", {
    payload: nativeOperationPayloadSchemas["suggest-files"],
    success: nativeOperationSuccessSchemas["suggest-files"],
    error: NativeOperationError,
  }),
  Rpc.make("filesystem.read-workspace-file", {
    payload: nativeOperationPayloadSchemas["read-workspace-file"],
    success: nativeOperationSuccessSchemas["read-workspace-file"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.reword-composer-selection", {
    payload: nativeOperationPayloadSchemas["reword-composer-selection"],
    success: nativeOperationSuccessSchemas["reword-composer-selection"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.generate-session-title", {
    payload: nativeOperationPayloadSchemas["generate-session-title"],
    success: nativeOperationSuccessSchemas["generate-session-title"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.set-utility-model", {
    payload: nativeOperationPayloadSchemas["set-utility-model"],
    success: nativeOperationSuccessSchemas["set-utility-model"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.register-project", {
    payload: nativeOperationPayloadSchemas["register-project"],
    success: nativeOperationSuccessSchemas["register-project"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.rename-project", {
    payload: nativeOperationPayloadSchemas["rename-project"],
    success: nativeOperationSuccessSchemas["rename-project"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.remove-project", {
    payload: nativeOperationPayloadSchemas["remove-project"],
    success: nativeOperationSuccessSchemas["remove-project"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.delete-session", {
    payload: nativeOperationPayloadSchemas["delete-session"],
    success: nativeOperationSuccessSchemas["delete-session"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.set-session-unread", {
    payload: nativeOperationPayloadSchemas["set-session-unread"],
    success: nativeOperationSuccessSchemas["set-session-unread"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.restart-pi", {
    payload: nativeOperationPayloadSchemas["restart-pi"],
    success: nativeOperationSuccessSchemas["restart-pi"],
    error: NativeOperationError,
  }),
  Rpc.make("managedWorktrees.create-worktree", {
    payload: nativeOperationPayloadSchemas["create-worktree"],
    success: nativeOperationSuccessSchemas["create-worktree"],
    error: ManagedWorktreeError,
  }),
  Rpc.make("managedWorktrees.get-worktree-status", {
    payload: nativeOperationPayloadSchemas["get-worktree-status"],
    success: nativeOperationSuccessSchemas["get-worktree-status"],
    error: ManagedWorktreeError,
  }),
  Rpc.make("managedWorktrees.land-worktree", {
    payload: nativeOperationPayloadSchemas["land-worktree"],
    success: nativeOperationSuccessSchemas["land-worktree"],
    error: ManagedWorktreeError,
  }),
  Rpc.make("terminals.open-terminal", {
    payload: nativeOperationPayloadSchemas["open-terminal"],
    success: nativeOperationSuccessSchemas["open-terminal"],
    error: TerminalError,
  }),
  Rpc.make("terminals.get-terminal-status", {
    payload: nativeOperationPayloadSchemas["get-terminal-status"],
    success: nativeOperationSuccessSchemas["get-terminal-status"],
    error: TerminalError,
  }),
  Rpc.make("vscode.get-embedded-editor-state", {
    payload: nativeOperationPayloadSchemas["get-embedded-editor-state"],
    success: nativeOperationSuccessSchemas["get-embedded-editor-state"],
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.set-vscode-server-path", {
    payload: nativeOperationPayloadSchemas["set-vscode-server-path"],
    success: nativeOperationSuccessSchemas["set-vscode-server-path"],
    error: VsCodeServerError,
  }),
  Rpc.make("artifacts.respond-artifact", {
    payload: nativeOperationPayloadSchemas["respond-artifact"],
    success: nativeOperationSuccessSchemas["respond-artifact"],
    error: ArtifactError,
  }),
  Rpc.make("artifacts.respond-ui", {
    payload: nativeOperationPayloadSchemas["respond-ui"],
    success: nativeOperationSuccessSchemas["respond-ui"],
    error: ArtifactError,
  }),
  Rpc.make("artifacts.export-artifacts", {
    payload: nativeOperationPayloadSchemas["export-artifacts"],
    success: nativeOperationSuccessSchemas["export-artifacts"],
    error: ArtifactError,
  }),
  Rpc.make("plugins.get-customization-state", {
    payload: nativeOperationPayloadSchemas["get-customization-state"],
    success: nativeOperationSuccessSchemas["get-customization-state"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.get-plugin-authoring-reference", {
    payload: nativeOperationPayloadSchemas["get-plugin-authoring-reference"],
    success: nativeOperationSuccessSchemas["get-plugin-authoring-reference"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.list-plugin-files", {
    payload: nativeOperationPayloadSchemas["list-plugin-files"],
    success: nativeOperationSuccessSchemas["list-plugin-files"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.create-plugin", {
    payload: nativeOperationPayloadSchemas["create-plugin"],
    success: nativeOperationSuccessSchemas["create-plugin"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.read-plugin-file", {
    payload: nativeOperationPayloadSchemas["read-plugin-file"],
    success: nativeOperationSuccessSchemas["read-plugin-file"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.write-plugin-file", {
    payload: nativeOperationPayloadSchemas["write-plugin-file"],
    success: nativeOperationSuccessSchemas["write-plugin-file"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.validate-customization", {
    payload: nativeOperationPayloadSchemas["validate-customization"],
    success: nativeOperationSuccessSchemas["validate-customization"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.activate-customization", {
    payload: nativeOperationPayloadSchemas["activate-customization"],
    success: nativeOperationSuccessSchemas["activate-customization"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.rollback-customization", {
    payload: nativeOperationPayloadSchemas["rollback-customization"],
    success: nativeOperationSuccessSchemas["rollback-customization"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.use-factory-customization", {
    payload: nativeOperationPayloadSchemas["use-factory-customization"],
    success: nativeOperationSuccessSchemas["use-factory-customization"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.list-plugins", {
    payload: nativeOperationPayloadSchemas["list-plugins"],
    success: nativeOperationSuccessSchemas["list-plugins"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.set-plugin-enabled", {
    payload: nativeOperationPayloadSchemas["set-plugin-enabled"],
    success: nativeOperationSuccessSchemas["set-plugin-enabled"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.set-active-scene", {
    payload: nativeOperationPayloadSchemas["set-active-scene"],
    success: nativeOperationSuccessSchemas["set-active-scene"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.delete-plugin", {
    payload: nativeOperationPayloadSchemas["delete-plugin"],
    success: nativeOperationSuccessSchemas["delete-plugin"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.compile-inline-widget", {
    payload: nativeOperationPayloadSchemas["compile-inline-widget"],
    success: nativeOperationSuccessSchemas["compile-inline-widget"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.repair-inline-widget", {
    payload: nativeOperationPayloadSchemas["repair-inline-widget"],
    success: nativeOperationSuccessSchemas["repair-inline-widget"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.open-plugin-agent", {
    payload: nativeOperationPayloadSchemas["open-plugin-agent"],
    success: nativeOperationSuccessSchemas["open-plugin-agent"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.prompt-plugin-agent", {
    payload: nativeOperationPayloadSchemas["prompt-plugin-agent"],
    success: nativeOperationSuccessSchemas["prompt-plugin-agent"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.abort-plugin-agent", {
    payload: nativeOperationPayloadSchemas["abort-plugin-agent"],
    success: nativeOperationSuccessSchemas["abort-plugin-agent"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.detach-plugin-agent", {
    payload: nativeOperationPayloadSchemas["detach-plugin-agent"],
    success: nativeOperationSuccessSchemas["detach-plugin-agent"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.run-plugin-completion", {
    payload: nativeOperationPayloadSchemas["run-plugin-completion"],
    success: nativeOperationSuccessSchemas["run-plugin-completion"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.cancel-plugin-completion", {
    payload: nativeOperationPayloadSchemas["cancel-plugin-completion"],
    success: nativeOperationSuccessSchemas["cancel-plugin-completion"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.load-plugin-state", {
    payload: nativeOperationPayloadSchemas["load-plugin-state"],
    success: nativeOperationSuccessSchemas["load-plugin-state"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.save-plugin-state", {
    payload: nativeOperationPayloadSchemas["save-plugin-state"],
    success: nativeOperationSuccessSchemas["save-plugin-state"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.call-plugin-backend", {
    payload: nativeOperationPayloadSchemas["call-plugin-backend"],
    success: nativeOperationSuccessSchemas["call-plugin-backend"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.cancel-plugin-backend-call", {
    payload: nativeOperationPayloadSchemas["cancel-plugin-backend-call"],
    success: nativeOperationSuccessSchemas["cancel-plugin-backend-call"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.customization-rendered", {
    payload: nativeOperationPayloadSchemas["customization-rendered"],
    success: nativeOperationSuccessSchemas["customization-rendered"],
    error: PluginRuntimeError,
  }),
  Rpc.make("plugins.customization-runtime-failed", {
    payload: nativeOperationPayloadSchemas["customization-runtime-failed"],
    success: nativeOperationSuccessSchemas["customization-runtime-failed"],
    error: PluginRuntimeError,
  }),
  Rpc.make("electron.set-fullscreen-surface-open", {
    payload: nativeOperationPayloadSchemas["set-fullscreen-surface-open"],
    success: nativeOperationSuccessSchemas["set-fullscreen-surface-open"],
    error: ElectronError,
  }),
  Rpc.make("workspaces.inspect-workspace", {
    payload: nativeOperationPayloadSchemas["inspect-workspace"],
    success: nativeOperationSuccessSchemas["inspect-workspace"],
    error: NativeOperationError,
  }),
  Rpc.make("workspaces.respond-workspace-trust", {
    payload: nativeOperationPayloadSchemas["respond-workspace-trust"],
    success: nativeOperationSuccessSchemas["respond-workspace-trust"],
    error: NativeOperationError,
  }),
  Rpc.make("managedWorktrees.discard-worktree", {
    payload: nativeOperationPayloadSchemas["discard-worktree"],
    success: nativeOperationSuccessSchemas["discard-worktree"],
    error: ManagedWorktreeError,
  }),
  Rpc.make("terminals.write-terminal", {
    payload: nativeOperationPayloadSchemas["write-terminal"],
    success: nativeOperationSuccessSchemas["write-terminal"],
    error: TerminalError,
  }),
  Rpc.make("terminals.resize-terminal", {
    payload: nativeOperationPayloadSchemas["resize-terminal"],
    success: nativeOperationSuccessSchemas["resize-terminal"],
    error: TerminalError,
  }),
  Rpc.make("terminals.close-terminal", {
    payload: nativeOperationPayloadSchemas["close-terminal"],
    success: nativeOperationSuccessSchemas["close-terminal"],
    error: TerminalError,
  }),
  Rpc.make("vscode.install-embedded-editor", {
    payload: nativeOperationPayloadSchemas["install-embedded-editor"],
    success: nativeOperationSuccessSchemas["install-embedded-editor"],
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.open-embedded-editor", {
    payload: nativeOperationPayloadSchemas["open-embedded-editor"],
    success: nativeOperationSuccessSchemas["open-embedded-editor"],
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.update-embedded-editor-bounds", {
    payload: nativeOperationPayloadSchemas["update-embedded-editor-bounds"],
    success: nativeOperationSuccessSchemas["update-embedded-editor-bounds"],
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.reveal-in-embedded-editor", {
    payload: nativeOperationPayloadSchemas["reveal-in-embedded-editor"],
    success: nativeOperationSuccessSchemas["reveal-in-embedded-editor"],
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.open-embedded-editor-source-control", {
    payload: nativeOperationPayloadSchemas["open-embedded-editor-source-control"],
    success: nativeOperationSuccessSchemas["open-embedded-editor-source-control"],
    error: VsCodeServerError,
  }),
  Rpc.make("vscode.update-embedded-editor-annotations", {
    payload: nativeOperationPayloadSchemas["update-embedded-editor-annotations"],
    success: nativeOperationSuccessSchemas["update-embedded-editor-annotations"],
    error: VsCodeServerError,
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
