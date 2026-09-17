import { Context, Effect, Layer, type Schema, type Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import { CakeRpc, type FoundationFailure } from "../protocol/CakeRpc";
import type { ArtifactError } from "../../domain/artifacts/artifact-data";
import type { ArtifactNotFound, ArtifactNotLinked } from "../../domain/artifacts/artifactWorkflows";
import type {
  ArtifactLineageDetail,
  ArtifactLineageId,
  ArtifactLineagePage,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevision,
  ArtifactRevisionNumber,
  ArtifactRevisionPage,
  ArtifactReferenceMetadata,
  ArtifactStableRef,
  ArtifactTextComparison,
  EffectiveArtifactProjection,
} from "../../domain/artifacts/artifact-lineage";
import type {
  ArtifactProjectionError,
  ArtifactProjectionMetadata,
} from "../../services/artifacts/ArtifactProjection";
import type {
  ArtifactPublicationConflict,
  ArtifactStorageError,
} from "../../services/storage/ArtifactStorage";
import type { SessionFamilyStorageError } from "../../services/storage/SessionFamilyStorage";
import type { ElectronError } from "../../services/electron/Electron";
import type { InlineWidgetError } from "../../services/widgets/InlineWidgets";
import type { TerminalError } from "../../services/terminal/Terminal";
import type {
  ResolvedManagedWorktreeCleanupPlan,
  ResolvedManagedWorktreeCleanupResult,
} from "../../domain/worktrees/managed-worktree-cleanup-data";
import type { WorktreeLandingError } from "../../domain/worktrees/worktree-landing-data";
import type { ManagedWorktreeCatalogUpdate } from "../../domain/worktrees/managed-worktree-data";
import type { WorktreeOperationCatalogUpdate } from "../../domain/worktrees/worktree-operation-data";
import type { ManagedWorktreeError } from "../../services/worktrees/ManagedWorktrees";
import type { VsCodeServerError } from "../../services/vscode/VsCodeServer";
import type { WorkspaceFileError } from "../../services/filesystem/WorkspaceFiles";
import type { ProjectError } from "../../domain/projects/project-error";
import type {
  CakeEvent as CakeEventEnvelope,
  CakeRpcOperation,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../cake-rpc-contract";

import type {
  RendererApplicationProjection,
  RendererApplicationState,
  ProjectWorkflow,
  SessionLabel,
  SessionLabelMutation,
  ProjectWorkflowSessionDetails,
} from "../../domain/application/application-data";
import type { AgentAvailabilitySnapshot } from "../../domain/application/agent-availability-data";
import type { PiSettingUpdate } from "../session-contract";
import type {
  ProjectSessionError,
  ProjectSessionCatalogQuery,
  ProjectSessionCompanionActionInput,
  ProjectSessionPreview,
  ProjectSessionStartInput,
  ProjectSessionTarget,
  ProjectSessionUpdate,
  WorkingDirectoryResolutionResult,
} from "../../domain/project-sessions/project-session-data";
import type {
  ConversationSnapshot,
  QueuedConversationMessages,
  SessionChatConfiguration,
  SessionChatError,
  SessionChatPromptInput,
  SessionChatTarget,
  TurnId,
} from "../../domain/conversations/conversation-data";
import type {
  CakeChatCatalogQuery,
  CakeChatError,
  CakeChatPreview,
  CakeChatStartInput,
  CakeChatTarget,
  CakeChatUpdate,
} from "../../domain/cake-chats/cake-chat-data";
import type {
  DiscussionSessionError,
  DiscussionSessionStartInput,
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
  DiscussionThread,
  SessionAssistantEnsureInput,
  SessionAssistantEnsured,
} from "../../domain/discussion-sessions/discussion-session-data";
import type {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/application/catalog-data";
import type {
  SubagentError,
  SubagentHandleId,
  SubagentUpdate,
} from "../../domain/subagents/subagent-data";
import type {
  ScheduleMessageInput,
  ScheduledMessage,
  ScheduledMessageError,
  ScheduledMessageUpdate,
} from "../../domain/scheduled-messages/scheduled-message-data";
import type {
  DefaultModelPresetNotFoundError,
  DuplicateModelPresetIdError,
  ModelPresetCreateInput,
  ModelPresetLimitError,
  ModelPresetNotFoundError,
  ModelPresetOrderInput,
  ModelPresetProjection,
  ModelPresetUpdateInput,
  ModelPresetValidationError,
} from "../../domain/model-presets/modelPresets";
import type {
  ModelSelection,
  PiModel,
  PiModelCatalogError,
  PiModelResolutionError,
  PiProviderAuthError,
} from "../../services/pi/model-data";
import type {
  ApplicationEncodeError,
  ApplicationWriteError,
} from "../../services/storage/ApplicationStorage";
import type {
  WindowStateEncodeError,
  WindowStateMalformedDocumentError,
  WindowStateReadError,
  WindowStateUnsupportedVersionError,
  WindowStateWriteError,
} from "../../services/storage/WindowStateStorage";

type TransportError = RpcClientError.RpcClientError;
type FocusedCakeEvent<Type extends CakeEventEnvelope["type"]> = Extract<
  CakeEventEnvelope,
  { readonly type: Type }
>;
type RpcCommand<Type extends CakeRpcOperation, OperationError> = (
  payload: (typeof cakeRpcPayloadSchemas)[Type]["Type"],
) => Effect.Effect<(typeof cakeRpcSuccessSchemas)[Type]["Type"], OperationError | TransportError>;
type RpcOperations<Types extends CakeRpcOperation, OperationError> = {
  readonly [Type in Types]: RpcCommand<Type, OperationError>;
};
type ArtifactOperationFailure =
  | ArtifactError
  | ArtifactNotFound
  | ArtifactNotLinked
  | ArtifactStorageError
  | ArtifactPublicationConflict
  | ArtifactProjectionError
  | SessionFamilyStorageError
  | TransportError;
type ModelPresetMutationError =
  | ModelPresetValidationError
  | ModelPresetNotFoundError
  | DefaultModelPresetNotFoundError
  | DuplicateModelPresetIdError
  | ModelPresetLimitError
  | ApplicationEncodeError
  | ApplicationWriteError
  | TransportError;
type ModelPresetResolutionError =
  | ModelPresetNotFoundError
  | PiModelResolutionError
  | PiModelCatalogError
  | TransportError;

export interface CakeIpcClientService {
  readonly application: {
    readonly getHomeDirectory: () => Effect.Effect<string, TransportError>;
    readonly getState: () => Effect.Effect<RendererApplicationState, TransportError>;
    readonly observeState: () => Stream.Stream<RendererApplicationProjection, TransportError>;
    readonly observeAgentAvailability: () => Stream.Stream<
      AgentAvailabilitySnapshot,
      TransportError
    >;
  };
  readonly windowState: {
    readonly load: () => Effect.Effect<
      Schema.Schema.Type<typeof Schema.Json>,
      | WindowStateReadError
      | WindowStateMalformedDocumentError
      | WindowStateUnsupportedVersionError
      | WindowStateEncodeError
      | WindowStateWriteError
      | TransportError
    >;
    readonly save: (
      snapshot: Schema.Schema.Type<typeof Schema.Json>,
    ) => Effect.Effect<void, WindowStateEncodeError | WindowStateWriteError | TransportError>;
  };
  readonly projects: {
    readonly observeCatalog: () => Stream.Stream<ProjectCatalogUpdate, TransportError>;
  };
  readonly projectWorkflow: {
    readonly mutateGlobal: (input: {
      readonly mutation: SessionLabelMutation;
    }) => Effect.Effect<ReadonlyArray<SessionLabel>, ProjectError | TransportError>;
    readonly mutate: (input: {
      readonly projectPath: string;
      readonly mutation: SessionLabelMutation;
    }) => Effect.Effect<ProjectWorkflow, ProjectError | TransportError>;
    readonly setSessionLabels: (input: {
      readonly projectPath: string;
      readonly sessionId: string;
      readonly workingDirectory: string;
      readonly labelIds: ReadonlyArray<string>;
    }) => Effect.Effect<ProjectWorkflow, ProjectError | TransportError>;
    readonly describeSession: (input: {
      readonly projectPath: string;
      readonly sessionId: string;
      readonly workingDirectory: string;
      readonly title: string;
      readonly firstUserMessage?: string;
    }) => Effect.Effect<ProjectWorkflowSessionDetails, ProjectError | TransportError>;
  };
  readonly models: {
    readonly list: () => Effect.Effect<
      ReadonlyArray<PiModel>,
      PiModelCatalogError | TransportError
    >;
    readonly refresh: () => Effect.Effect<void, PiModelCatalogError | TransportError>;
    readonly login: (input: {
      readonly provider: string;
      readonly authType: "api_key" | "oauth";
    }) => Effect.Effect<void, PiProviderAuthError | TransportError>;
    readonly logout: (input: {
      readonly provider: string;
    }) => Effect.Effect<void, PiProviderAuthError | TransportError>;
  };
  readonly modelPresets: {
    readonly list: () => Effect.Effect<ModelPresetProjection, TransportError>;
    readonly create: (
      input: ModelPresetCreateInput,
    ) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly update: (
      input: ModelPresetUpdateInput,
    ) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly reorder: (
      input: ModelPresetOrderInput,
    ) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly remove: (id: string) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly setDefault: (
      id?: string,
    ) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly resolve: (id: string) => Effect.Effect<ModelSelection, ModelPresetResolutionError>;
  };
  readonly sessionChats: {
    readonly prompt: (
      input: SessionChatPromptInput,
    ) => Effect.Effect<TurnId, SessionChatError | TransportError>;
    readonly steer: (
      input: SessionChatPromptInput,
    ) => Effect.Effect<TurnId, SessionChatError | TransportError>;
    readonly followUp: (
      input: SessionChatPromptInput,
    ) => Effect.Effect<TurnId, SessionChatError | TransportError>;
    readonly abort: (
      target: SessionChatTarget,
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly listQueuedMessages: (
      target: SessionChatTarget,
    ) => Effect.Effect<QueuedConversationMessages, SessionChatError | TransportError>;
    readonly clearQueue: (
      target: SessionChatTarget,
    ) => Effect.Effect<QueuedConversationMessages, SessionChatError | TransportError>;
    readonly cancelSteering: (
      target: SessionChatTarget,
    ) => Effect.Effect<QueuedConversationMessages, SessionChatError | TransportError>;
    readonly removeQueuedMessage: (
      input: SessionChatTarget & { readonly partId: string },
    ) => Effect.Effect<QueuedConversationMessages, SessionChatError | TransportError>;
    readonly steerQueuedMessage: (
      input: SessionChatTarget & { readonly partId: string },
    ) => Effect.Effect<QueuedConversationMessages, SessionChatError | TransportError>;
    readonly compact: (
      input: SessionChatTarget & { readonly instructions?: string },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly editMessage: (
      input: SessionChatPromptInput & { readonly entryId: string },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly setUserMessageMarkdown: (
      input: SessionChatTarget & { readonly entryId: string; readonly renderAsMarkdown: boolean },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly applyConfiguration: (
      input: SessionChatTarget & { readonly configuration: SessionChatConfiguration },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly setModel: (
      input: SessionChatTarget & { readonly provider: string; readonly modelId: string },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly setThinkingLevel: (
      input: SessionChatTarget & { readonly level: SessionChatConfiguration["thinkingLevel"] },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly setFastMode: (
      input: SessionChatTarget & { readonly enabled: boolean },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly setPiSetting: (
      input: SessionChatTarget & { readonly update: PiSettingUpdate },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly reload: (
      target: SessionChatTarget,
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly login: (
      input: SessionChatTarget & {
        readonly provider: string;
        readonly authType: "api_key" | "oauth";
      },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
    readonly logout: (
      input: SessionChatTarget & { readonly provider: string },
    ) => Effect.Effect<void, SessionChatError | TransportError>;
  };
  readonly cakeChats: {
    readonly observeCatalog: (
      input: CakeChatCatalogQuery,
    ) => Stream.Stream<CakeChatCatalogUpdate, CakeChatError | TransportError>;
    readonly inspect: (
      sessionId: string,
    ) => Effect.Effect<CakeChatPreview, CakeChatError | TransportError>;
    readonly open: (
      target: CakeChatTarget,
    ) => Effect.Effect<ConversationSnapshot, CakeChatError | TransportError>;
    readonly observe: (
      target: CakeChatTarget,
    ) => Stream.Stream<CakeChatUpdate, CakeChatError | TransportError>;
    readonly start: (
      input: CakeChatStartInput,
    ) => Effect.Effect<TurnId, CakeChatError | TransportError>;
    readonly rename: (
      input: CakeChatTarget & { readonly name: string },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly toolCompact: (
      input: CakeChatTarget & {
        readonly entryId: string;
        readonly prompt?: string;
      },
    ) => Effect.Effect<
      { readonly sessionId: string; readonly turnId?: TurnId },
      CakeChatError | TransportError
    >;
    readonly resolve: (
      target: CakeChatTarget,
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly restore: (
      target: CakeChatTarget,
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly deleteResolved: (
      target: CakeChatTarget,
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly respondControl: (
      controlRequestId: string,
      result: Schema.Schema.Type<typeof Schema.Json>,
    ) => Effect.Effect<void, CakeChatError | TransportError>;
  };
  readonly discussionSessions: {
    readonly observeCatalog: (input: {
      readonly workingDirectory: string;
      readonly parentSessionId: string;
    }) => Stream.Stream<DiscussionCatalogUpdate, DiscussionSessionError | TransportError>;
    readonly list: (input: {
      readonly workingDirectory: string;
      readonly parentSessionId: string;
    }) => Effect.Effect<ReadonlyArray<DiscussionThread>, DiscussionSessionError | TransportError>;
    readonly observe: (
      target: DiscussionSessionTarget,
    ) => Stream.Stream<DiscussionSessionUpdate, DiscussionSessionError | TransportError>;
    readonly start: (
      input: DiscussionSessionStartInput,
    ) => Effect.Effect<
      { readonly turnId: TurnId; readonly thread: DiscussionThread },
      DiscussionSessionError | TransportError
    >;
    readonly ensureSessionAssistant: (
      input: SessionAssistantEnsureInput,
    ) => Effect.Effect<SessionAssistantEnsured, DiscussionSessionError | TransportError>;
    readonly setResolved: (
      target: DiscussionSessionTarget & { readonly resolved: boolean },
    ) => Effect.Effect<DiscussionThread, DiscussionSessionError | TransportError>;
  };
  readonly scheduledMessages: {
    readonly observe: (
      targetSessionId: string,
    ) => Stream.Stream<ScheduledMessageUpdate, ScheduledMessageError | TransportError>;
    readonly list: (
      targetSessionId?: string,
    ) => Effect.Effect<ReadonlyArray<ScheduledMessage>, ScheduledMessageError | TransportError>;
    readonly schedule: (
      input: ScheduleMessageInput,
    ) => Effect.Effect<ScheduledMessage, ScheduledMessageError | TransportError>;
    readonly cancel: (id: string) => Effect.Effect<void, ScheduledMessageError | TransportError>;
  };
  readonly projectSessions: {
    readonly observeCatalog: (
      input: ProjectSessionCatalogQuery,
    ) => Stream.Stream<SessionCatalogUpdate, ProjectSessionError | TransportError>;
    readonly inspect: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<ProjectSessionPreview, ProjectSessionError | TransportError>;
    readonly start: (
      input: ProjectSessionStartInput,
    ) => Effect.Effect<TurnId, ProjectSessionError | TransportError>;
    readonly open: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly observe: (
      target: ProjectSessionTarget,
    ) => Stream.Stream<ProjectSessionUpdate, ProjectSessionError | TransportError>;
    readonly getChangelog: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<string, ProjectSessionError | TransportError>;
    readonly navigate: (
      input: ProjectSessionTarget & {
        readonly entryId: string;
        readonly summarize: boolean;
        readonly customInstructions?: string;
      },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly dispatchExtensionCompanionAction: (
      input: ProjectSessionCompanionActionInput,
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly toolCompact: (
      input: ProjectSessionTarget & {
        readonly entryId: string;
        readonly prompt?: string;
      },
    ) => Effect.Effect<{ readonly sessionId: string }, ProjectSessionError | TransportError>;
    readonly rename: (
      target: ProjectSessionTarget & { readonly name: string },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly fork: (
      input: ProjectSessionTarget & {
        readonly entryId: string;
        readonly destinationWorkingDirectory?: string;
        readonly resolveSource?: boolean;
      },
    ) => Effect.Effect<{ readonly sessionId: string }, ProjectSessionError | TransportError>;
    readonly resolve: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly resolveWorkingDirectory: (input: {
      readonly workingDirectory: string;
    }) => Effect.Effect<WorkingDirectoryResolutionResult, ProjectSessionError | TransportError>;
    readonly restore: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly respondControl: (
      sessionId: string,
      controlRequestId: string,
      result: Schema.Schema.Type<typeof Schema.Json>,
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
  };
  readonly subagents: {
    readonly observe: (
      parentSessionId: string,
    ) => Stream.Stream<SubagentUpdate, SubagentError | TransportError>;
    readonly prompt: (input: {
      readonly parentSessionId: string;
      readonly handleId: SubagentHandleId;
      readonly text: string;
    }) => Effect.Effect<void, SubagentError | TransportError>;
    readonly steer: (input: {
      readonly parentSessionId: string;
      readonly handleId: SubagentHandleId;
      readonly text: string;
    }) => Effect.Effect<void, SubagentError | TransportError>;
    readonly abort: (input: {
      readonly parentSessionId: string;
      readonly handleId: SubagentHandleId;
    }) => Effect.Effect<void, SubagentError | TransportError>;
    readonly close: (input: {
      readonly parentSessionId: string;
      readonly handleId: SubagentHandleId;
    }) => Effect.Effect<void, SubagentError | TransportError>;
  };
  readonly electron: RpcOperations<
    | "choose-project"
    | "open-external-url"
    | "show-notification"
    | "show-transcript-selection-context-menu"
    | "show-composer-context-menu"
    | "show-session-context-menu"
    | "show-project-context-menu"
    | "set-fullscreen-surface-open",
    ElectronError
  >;
  readonly filesystem: RpcOperations<
    "choose-attachments" | "suggest-files" | "read-workspace-file",
    WorkspaceFileError
  >;
  readonly workspaces: RpcOperations<
    | "reword-composer-selection"
    | "generate-session-title"
    | "set-utility-model"
    | "load-staged-slash-commands"
    | "register-project"
    | "rename-project"
    | "set-project-settings"
    | "remove-project"
    | "delete-session"
    | "set-session-unread"
    | "restart-pi"
    | "inspect-workspace"
    | "respond-workspace-trust",
    ProjectError
  >;
  readonly managedWorktrees: RpcOperations<
    | "create-worktree"
    | "get-worktree-landing"
    | "start-worktree-landing"
    | "retry-worktree-landing"
    | "cancel-worktree-landing"
    | "start-worktree-rebase"
    | "discard-worktree",
    ManagedWorktreeError | WorktreeLandingError
  > & {
    readonly observeCatalog: () => Stream.Stream<
      ManagedWorktreeCatalogUpdate,
      ManagedWorktreeError | TransportError
    >;
    readonly observeOperations: () => Stream.Stream<WorktreeOperationCatalogUpdate, TransportError>;
    readonly inspectResolvedForProject: (input: {
      readonly projectPath: string;
    }) => Effect.Effect<ResolvedManagedWorktreeCleanupPlan, ManagedWorktreeError | TransportError>;
    readonly discardResolvedForProject: (input: {
      readonly projectPath: string;
    }) => Effect.Effect<
      ResolvedManagedWorktreeCleanupResult,
      ManagedWorktreeError | TransportError
    >;
  };
  readonly terminals: RpcOperations<
    | "open-terminal"
    | "write-terminal"
    | "resize-terminal"
    | "get-terminal-status"
    | "close-terminal"
    | "close-working-directory-terminals",
    TerminalError
  >;
  readonly vscode: RpcOperations<
    | "get-embedded-editor-state"
    | "set-vscode-server-path"
    | "install-embedded-editor"
    | "open-embedded-editor"
    | "update-embedded-editor-bounds"
    | "reveal-in-embedded-editor"
    | "open-embedded-editor-source-control"
    | "update-embedded-editor-annotations",
    VsCodeServerError
  > & {
    readonly observeState: () => Stream.Stream<
      (typeof cakeRpcSuccessSchemas)["get-embedded-editor-state"]["Type"],
      TransportError
    >;
  };
  readonly artifacts: RpcOperations<
    "respond-artifact" | "respond-ui" | "export-artifacts",
    ArtifactError
  > & {
    readonly catalog: (input: {
      readonly search?: string;
      readonly offset?: number;
      readonly limit?: number;
    }) => Effect.Effect<ArtifactLineagePage, ArtifactOperationFailure>;
    readonly effective: (
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<EffectiveArtifactProjection>, ArtifactOperationFailure>;
    readonly detail: (
      lineageId: ArtifactLineageId,
    ) => Effect.Effect<ArtifactLineageDetail, ArtifactOperationFailure>;
    readonly history: (input: {
      readonly lineageId: ArtifactLineageId;
      readonly offset?: number;
      readonly limit?: number;
    }) => Effect.Effect<ArtifactRevisionPage, ArtifactOperationFailure>;
    readonly readExact: (
      lineageId: ArtifactLineageId,
      revision: ArtifactRevisionNumber,
    ) => Effect.Effect<ArtifactRevision, ArtifactOperationFailure>;
    readonly referenceMetadata: (
      reference: ArtifactStableRef,
    ) => Effect.Effect<ArtifactReferenceMetadata, ArtifactOperationFailure>;
    readonly compareText: (
      lineageId: ArtifactLineageId,
      fromRevision: ArtifactRevisionNumber,
      toRevision: ArtifactRevisionNumber,
    ) => Effect.Effect<ArtifactTextComparison, ArtifactOperationFailure>;
    readonly restore: (input: {
      readonly sessionId: string;
      readonly lineageId: ArtifactLineageId;
      readonly sourceRevision: ArtifactRevisionNumber;
      readonly expectedLatestRevision: number;
    }) => Effect.Effect<ArtifactRevision, ArtifactOperationFailure>;
    readonly link: (input: {
      readonly sessionId: string;
      readonly lineageId: ArtifactLineageId;
      readonly target: ArtifactLinkTarget;
      readonly selection: ArtifactLink["selection"];
    }) => Effect.Effect<ArtifactLink, ArtifactOperationFailure>;
    readonly unlink: (input: {
      readonly sessionId: string;
      readonly lineageId: ArtifactLineageId;
      readonly target: ArtifactLinkTarget;
    }) => Effect.Effect<void, ArtifactOperationFailure>;
    readonly setSelection: (input: {
      readonly sessionId: string;
      readonly lineageId: ArtifactLineageId;
      readonly target: ArtifactLinkTarget;
      readonly selection: ArtifactLink["selection"];
    }) => Effect.Effect<ArtifactLink, ArtifactOperationFailure>;
    readonly materialize: (
      sessionId: string,
      lineageId: ArtifactLineageId,
      revision: ArtifactRevisionNumber,
    ) => Effect.Effect<ArtifactProjectionMetadata, ArtifactOperationFailure>;
  };
  readonly widgets: RpcOperations<"compile-inline-widget", InlineWidgetError>;
  readonly events: {
    readonly application: () => Stream.Stream<
      FocusedCakeEvent<
        | "changelog-snapshot"
        | "complete"
        | "fatal"
        | "notification"
        | "extension-ui-intent"
        | "project-session-control-requested"
        | "application-hotkey-input"
        | "renderer-events-ready"
      >,
      TransportError
    >;
    readonly artifacts: () => Stream.Stream<
      FocusedCakeEvent<
        | "artifact-updated"
        | "artifact-catalog-invalidated"
        | "artifact-requested"
        | "ui-request"
        | "renderer-events-ready"
      >,
      TransportError
    >;
    readonly terminals: () => Stream.Stream<
      FocusedCakeEvent<
        "terminal-data" | "terminal-exited" | "terminal-toggle-requested" | "renderer-events-ready"
      >,
      TransportError
    >;
    readonly vscode: () => Stream.Stream<
      FocusedCakeEvent<
        | "embedded-editor-toggle-mode-requested"
        | "embedded-editor-selection"
        | "embedded-editor-back-to-agent"
        | "embedded-editor-annotation-opened"
        | "embedded-editor-toggle-chat"
        | "embedded-editor-toggle-sidebar"
        | "embedded-editor-selection-cleared"
        | "embedded-editor-entered"
        | "embedded-editor-annotation-requested"
        | "embedded-editor-side-chat-requested"
        | "renderer-events-ready"
      >,
      TransportError
    >;
    readonly surfaces: () => Stream.Stream<
      FocusedCakeEvent<"fullscreen-surface-close-requested" | "renderer-events-ready">,
      TransportError
    >;
  };
  readonly foundation: {
    readonly typedFailure: () => Effect.Effect<void, FoundationFailure | TransportError>;
    readonly stream: (input: {
      readonly count: number;
      readonly intervalMs: number;
    }) => Stream.Stream<number, TransportError>;
    readonly delay: (input: { readonly durationMs: number }) => Effect.Effect<void, TransportError>;
    readonly activeRequests: () => Effect.Effect<
      { readonly delays: number; readonly streams: number },
      TransportError
    >;
  };
}

export class CakeIpcClient extends Context.Service<CakeIpcClient, CakeIpcClientService>()(
  "cake/ipc/client/CakeIpcClient",
) {}

export const CakeIpcClientLive = Layer.effect(
  CakeIpcClient,
  Effect.gen(function* () {
    const client = yield* RpcClient.make(CakeRpc, { flatten: true, spanPrefix: "CakeIpcClient" });
    return CakeIpcClient.of({
      application: {
        getHomeDirectory: Effect.fn("CakeIpcClient.application.getHomeDirectory")(() =>
          client("application.getHomeDirectory", undefined),
        ),
        getState: Effect.fn("CakeIpcClient.application.getState")(() =>
          client("application.getState", undefined),
        ),
        observeState: () => client("application.observeState", undefined),
        observeAgentAvailability: () => client("application.observeAgentAvailability", undefined),
      },
      windowState: {
        load: Effect.fn("CakeIpcClient.windowState.load")(() =>
          client("windowState.load", undefined),
        ),
        save: Effect.fn("CakeIpcClient.windowState.save")((snapshot) =>
          client("windowState.save", { snapshot }),
        ),
      },
      projects: {
        observeCatalog: () => client("projects.observeCatalog", undefined),
      },
      projectWorkflow: {
        mutateGlobal: Effect.fn("CakeIpcClient.projectWorkflow.mutateGlobal")((input) =>
          client("projectWorkflow.mutateGlobal", input),
        ),
        mutate: Effect.fn("CakeIpcClient.projectWorkflow.mutate")((input) =>
          client("projectWorkflow.mutate", input),
        ),
        setSessionLabels: Effect.fn("CakeIpcClient.projectWorkflow.setSessionLabels")((input) =>
          client("projectWorkflow.setSessionLabels", input),
        ),
        describeSession: Effect.fn("CakeIpcClient.projectWorkflow.describeSession")((input) =>
          client("projectWorkflow.describeSession", input),
        ),
      },
      models: {
        list: Effect.fn("CakeIpcClient.models.list")(() => client("models.list", undefined)),
        refresh: Effect.fn("CakeIpcClient.models.refresh")(() =>
          client("models.refresh", undefined),
        ),
        login: Effect.fn("CakeIpcClient.models.login")((input) => client("models.login", input)),
        logout: Effect.fn("CakeIpcClient.models.logout")((input) => client("models.logout", input)),
      },
      modelPresets: {
        list: Effect.fn("CakeIpcClient.modelPresets.list")(() =>
          client("modelPresets.list", undefined),
        ),
        create: Effect.fn("CakeIpcClient.modelPresets.create")((input) =>
          client("modelPresets.create", input),
        ),
        update: Effect.fn("CakeIpcClient.modelPresets.update")((input) =>
          client("modelPresets.update", input),
        ),
        reorder: Effect.fn("CakeIpcClient.modelPresets.reorder")((input) =>
          client("modelPresets.reorder", input),
        ),
        remove: Effect.fn("CakeIpcClient.modelPresets.remove")((id) =>
          client("modelPresets.remove", { id }),
        ),
        setDefault: Effect.fn("CakeIpcClient.modelPresets.setDefault")((id) =>
          client("modelPresets.setDefault", { id }),
        ),
        resolve: Effect.fn("CakeIpcClient.modelPresets.resolve")((id) =>
          client("modelPresets.resolve", { id }),
        ),
      },
      sessionChats: {
        prompt: Effect.fn("CakeIpcClient.sessionChats.prompt")((input) =>
          client("sessionChats.prompt", input),
        ),
        steer: Effect.fn("CakeIpcClient.sessionChats.steer")((input) =>
          client("sessionChats.steer", input),
        ),
        followUp: Effect.fn("CakeIpcClient.sessionChats.followUp")((input) =>
          client("sessionChats.followUp", input),
        ),
        abort: Effect.fn("CakeIpcClient.sessionChats.abort")((target) =>
          client("sessionChats.abort", target),
        ),
        listQueuedMessages: Effect.fn("CakeIpcClient.sessionChats.listQueuedMessages")((target) =>
          client("sessionChats.listQueuedMessages", target),
        ),
        clearQueue: Effect.fn("CakeIpcClient.sessionChats.clearQueue")((target) =>
          client("sessionChats.clearQueue", target),
        ),
        cancelSteering: Effect.fn("CakeIpcClient.sessionChats.cancelSteering")((target) =>
          client("sessionChats.cancelSteering", target),
        ),
        removeQueuedMessage: Effect.fn("CakeIpcClient.sessionChats.removeQueuedMessage")((input) =>
          client("sessionChats.removeQueuedMessage", input),
        ),
        steerQueuedMessage: Effect.fn("CakeIpcClient.sessionChats.steerQueuedMessage")((input) =>
          client("sessionChats.steerQueuedMessage", input),
        ),
        compact: Effect.fn("CakeIpcClient.sessionChats.compact")((input) =>
          client("sessionChats.compact", input),
        ),
        editMessage: Effect.fn("CakeIpcClient.sessionChats.editMessage")((input) =>
          client("sessionChats.editMessage", input),
        ),
        setUserMessageMarkdown: Effect.fn("CakeIpcClient.sessionChats.setUserMessageMarkdown")(
          (input) => client("sessionChats.setUserMessageMarkdown", input),
        ),
        applyConfiguration: Effect.fn("CakeIpcClient.sessionChats.applyConfiguration")((input) =>
          client("sessionChats.applyConfiguration", input),
        ),
        setModel: Effect.fn("CakeIpcClient.sessionChats.setModel")((input) =>
          client("sessionChats.setModel", input),
        ),
        setThinkingLevel: Effect.fn("CakeIpcClient.sessionChats.setThinkingLevel")((input) =>
          client("sessionChats.setThinkingLevel", input),
        ),
        setFastMode: Effect.fn("CakeIpcClient.sessionChats.setFastMode")((input) =>
          client("sessionChats.setFastMode", input),
        ),
        setPiSetting: Effect.fn("CakeIpcClient.sessionChats.setPiSetting")((input) =>
          client("sessionChats.setPiSetting", input),
        ),
        reload: Effect.fn("CakeIpcClient.sessionChats.reload")((target) =>
          client("sessionChats.reload", target),
        ),
        login: Effect.fn("CakeIpcClient.sessionChats.login")((input) =>
          client("sessionChats.login", input),
        ),
        logout: Effect.fn("CakeIpcClient.sessionChats.logout")((input) =>
          client("sessionChats.logout", input),
        ),
      },
      cakeChats: {
        observeCatalog: (input) => client("cakeChats.observeCatalog", input),
        inspect: Effect.fn("CakeIpcClient.cakeChats.inspect")((sessionId) =>
          client("cakeChats.inspect", { sessionId }),
        ),
        open: Effect.fn("CakeIpcClient.cakeChats.open")((target) =>
          client("cakeChats.open", target),
        ),
        observe: (target) => client("cakeChats.observe", target),
        start: Effect.fn("CakeIpcClient.cakeChats.start")((input) =>
          client("cakeChats.start", input),
        ),
        rename: Effect.fn("CakeIpcClient.cakeChats.rename")((input) =>
          client("cakeChats.rename", input),
        ),
        toolCompact: Effect.fn("CakeIpcClient.cakeChats.toolCompact")((input) =>
          client("cakeChats.toolCompact", input),
        ),
        resolve: Effect.fn("CakeIpcClient.cakeChats.resolve")((target) =>
          client("cakeChats.resolve", target),
        ),
        restore: Effect.fn("CakeIpcClient.cakeChats.restore")((target) =>
          client("cakeChats.restore", target),
        ),
        deleteResolved: Effect.fn("CakeIpcClient.cakeChats.deleteResolved")((target) =>
          client("cakeChats.deleteResolved", target),
        ),
        respondControl: Effect.fn("CakeIpcClient.cakeChats.respondControl")(
          (controlRequestId, result) =>
            client("cakeChats.respondControl", { controlRequestId, result }),
        ),
      },
      discussionSessions: {
        observeCatalog: (input) => client("discussionSessions.observeCatalog", input),
        list: Effect.fn("CakeIpcClient.discussionSessions.list")((input) =>
          client("discussionSessions.list", input),
        ),
        observe: (target) => client("discussionSessions.observe", target),
        start: Effect.fn("CakeIpcClient.discussionSessions.start")((input) =>
          client("discussionSessions.start", input),
        ),
        ensureSessionAssistant: Effect.fn(
          "CakeIpcClient.discussionSessions.ensureSessionAssistant",
        )((input) => client("discussionSessions.ensureSessionAssistant", input)),
        setResolved: Effect.fn("CakeIpcClient.discussionSessions.setResolved")((target) =>
          client("discussionSessions.setResolved", target),
        ),
      },
      scheduledMessages: {
        observe: (targetSessionId) => client("scheduledMessages.observe", { targetSessionId }),
        list: Effect.fn("CakeIpcClient.scheduledMessages.list")((targetSessionId) =>
          client("scheduledMessages.list", targetSessionId ? { targetSessionId } : {}),
        ),
        schedule: Effect.fn("CakeIpcClient.scheduledMessages.schedule")((input) =>
          client("scheduledMessages.schedule", input),
        ),
        cancel: Effect.fn("CakeIpcClient.scheduledMessages.cancel")((id) =>
          client("scheduledMessages.cancel", { id }),
        ),
      },
      projectSessions: {
        observeCatalog: (input) => client("projectSessions.observeCatalog", input),
        inspect: Effect.fn("CakeIpcClient.projectSessions.inspect")((target) =>
          client("projectSessions.inspect", target),
        ),
        start: Effect.fn("CakeIpcClient.projectSessions.start")((input) =>
          client("projectSessions.start", input),
        ),
        open: Effect.fn("CakeIpcClient.projectSessions.open")((target) =>
          client("projectSessions.open", target),
        ),
        observe: (target) => client("projectSessions.observe", target),
        getChangelog: Effect.fn("CakeIpcClient.projectSessions.getChangelog")((target) =>
          client("projectSessions.getChangelog", target),
        ),
        navigate: Effect.fn("CakeIpcClient.projectSessions.navigate")((input) =>
          client("projectSessions.navigate", input),
        ),
        dispatchExtensionCompanionAction: Effect.fn(
          "CakeIpcClient.projectSessions.dispatchExtensionCompanionAction",
        )((input) => client("projectSessions.dispatchExtensionCompanionAction", input)),
        toolCompact: Effect.fn("CakeIpcClient.projectSessions.toolCompact")((input) =>
          client("projectSessions.toolCompact", input),
        ),
        rename: Effect.fn("CakeIpcClient.projectSessions.rename")((input) =>
          client("projectSessions.rename", input),
        ),
        fork: Effect.fn("CakeIpcClient.projectSessions.fork")((input) =>
          client("projectSessions.fork", input),
        ),
        resolve: Effect.fn("CakeIpcClient.projectSessions.resolve")((target) =>
          client("projectSessions.resolve", target),
        ),
        resolveWorkingDirectory: Effect.fn("CakeIpcClient.projectSessions.resolveWorkingDirectory")(
          (input) => client("projectSessions.resolveWorkingDirectory", input),
        ),
        restore: Effect.fn("CakeIpcClient.projectSessions.restore")((target) =>
          client("projectSessions.restore", target),
        ),
        respondControl: Effect.fn("CakeIpcClient.projectSessions.respondControl")(
          (sessionId, controlRequestId, result) =>
            client("projectSessions.respondControl", { sessionId, controlRequestId, result }),
        ),
      },
      subagents: {
        observe: (parentSessionId) => client("subagents.observe", { parentSessionId }),
        prompt: Effect.fn("CakeIpcClient.subagents.prompt")((input) =>
          client("subagents.prompt", input),
        ),
        steer: Effect.fn("CakeIpcClient.subagents.steer")((input) =>
          client("subagents.steer", input),
        ),
        abort: Effect.fn("CakeIpcClient.subagents.abort")((input) =>
          client("subagents.abort", input),
        ),
        close: Effect.fn("CakeIpcClient.subagents.close")((input) =>
          client("subagents.close", input),
        ),
      },

      electron: {
        "choose-project": Effect.fn("CakeIpcClient.electron.choose-project")((payload) =>
          client("electron.choose-project", payload),
        ),
        "open-external-url": Effect.fn("CakeIpcClient.electron.open-external-url")((payload) =>
          client("electron.open-external-url", payload),
        ),
        "show-notification": Effect.fn("CakeIpcClient.electron.show-notification")((payload) =>
          client("electron.show-notification", payload),
        ),
        "show-transcript-selection-context-menu": Effect.fn(
          "CakeIpcClient.electron.show-transcript-selection-context-menu",
        )((payload) => client("electron.show-transcript-selection-context-menu", payload)),
        "show-composer-context-menu": Effect.fn(
          "CakeIpcClient.electron.show-composer-context-menu",
        )((payload) => client("electron.show-composer-context-menu", payload)),
        "show-session-context-menu": Effect.fn("CakeIpcClient.electron.show-session-context-menu")(
          (payload) => client("electron.show-session-context-menu", payload),
        ),
        "show-project-context-menu": Effect.fn("CakeIpcClient.electron.show-project-context-menu")(
          (payload) => client("electron.show-project-context-menu", payload),
        ),
        "set-fullscreen-surface-open": Effect.fn(
          "CakeIpcClient.electron.set-fullscreen-surface-open",
        )((payload) => client("electron.set-fullscreen-surface-open", payload)),
      },
      filesystem: {
        "choose-attachments": Effect.fn("CakeIpcClient.filesystem.choose-attachments")((payload) =>
          client("filesystem.choose-attachments", payload),
        ),
        "suggest-files": Effect.fn("CakeIpcClient.filesystem.suggest-files")((payload) =>
          client("filesystem.suggest-files", payload),
        ),
        "read-workspace-file": Effect.fn("CakeIpcClient.filesystem.read-workspace-file")(
          (payload) => client("filesystem.read-workspace-file", payload),
        ),
      },
      workspaces: {
        "reword-composer-selection": Effect.fn(
          "CakeIpcClient.workspaces.reword-composer-selection",
        )((payload) => client("workspaces.reword-composer-selection", payload)),
        "generate-session-title": Effect.fn("CakeIpcClient.workspaces.generate-session-title")(
          (payload) => client("workspaces.generate-session-title", payload),
        ),
        "set-utility-model": Effect.fn("CakeIpcClient.workspaces.set-utility-model")((payload) =>
          client("workspaces.set-utility-model", payload),
        ),
        "load-staged-slash-commands": Effect.fn(
          "CakeIpcClient.workspaces.load-staged-slash-commands",
        )((payload) => client("workspaces.load-staged-slash-commands", payload)),
        "register-project": Effect.fn("CakeIpcClient.workspaces.register-project")((payload) =>
          client("workspaces.register-project", payload),
        ),
        "rename-project": Effect.fn("CakeIpcClient.workspaces.rename-project")((payload) =>
          client("workspaces.rename-project", payload),
        ),
        "set-project-settings": Effect.fn("CakeIpcClient.workspaces.set-project-settings")(
          (payload) => client("workspaces.set-project-settings", payload),
        ),
        "remove-project": Effect.fn("CakeIpcClient.workspaces.remove-project")((payload) =>
          client("workspaces.remove-project", payload),
        ),
        "delete-session": Effect.fn("CakeIpcClient.workspaces.delete-session")((payload) =>
          client("workspaces.delete-session", payload),
        ),
        "set-session-unread": Effect.fn("CakeIpcClient.workspaces.set-session-unread")((payload) =>
          client("workspaces.set-session-unread", payload),
        ),
        "restart-pi": Effect.fn("CakeIpcClient.workspaces.restart-pi")((payload) =>
          client("workspaces.restart-pi", payload),
        ),
        "inspect-workspace": Effect.fn("CakeIpcClient.workspaces.inspect-workspace")((payload) =>
          client("workspaces.inspect-workspace", payload),
        ),
        "respond-workspace-trust": Effect.fn("CakeIpcClient.workspaces.respond-workspace-trust")(
          (payload) => client("workspaces.respond-workspace-trust", payload),
        ),
      },
      managedWorktrees: {
        observeCatalog: () => client("managedWorktrees.observeCatalog", undefined),
        observeOperations: () => client("managedWorktrees.observeOperations", undefined),
        "create-worktree": Effect.fn("CakeIpcClient.managedWorktrees.create-worktree")((payload) =>
          client("managedWorktrees.create-worktree", payload),
        ),
        "get-worktree-landing": Effect.fn("CakeIpcClient.managedWorktrees.get-worktree-landing")(
          (payload) => client("managedWorktrees.get-worktree-landing", payload),
        ),
        "start-worktree-landing": Effect.fn(
          "CakeIpcClient.managedWorktrees.start-worktree-landing",
        )((payload) => client("managedWorktrees.start-worktree-landing", payload)),
        "retry-worktree-landing": Effect.fn(
          "CakeIpcClient.managedWorktrees.retry-worktree-landing",
        )((payload) => client("managedWorktrees.retry-worktree-landing", payload)),
        "cancel-worktree-landing": Effect.fn(
          "CakeIpcClient.managedWorktrees.cancel-worktree-landing",
        )((payload) => client("managedWorktrees.cancel-worktree-landing", payload)),
        "start-worktree-rebase": Effect.fn("CakeIpcClient.managedWorktrees.start-worktree-rebase")(
          (payload) => client("managedWorktrees.start-worktree-rebase", payload),
        ),
        "discard-worktree": Effect.fn("CakeIpcClient.managedWorktrees.discard-worktree")(
          (payload) => client("managedWorktrees.discard-worktree", payload),
        ),
        inspectResolvedForProject: Effect.fn(
          "CakeIpcClient.managedWorktrees.inspectResolvedForProject",
        )((input) => client("managedWorktrees.inspectResolvedForProject", input)),
        discardResolvedForProject: Effect.fn(
          "CakeIpcClient.managedWorktrees.discardResolvedForProject",
        )((input) => client("managedWorktrees.discardResolvedForProject", input)),
      },
      terminals: {
        "open-terminal": Effect.fn("CakeIpcClient.terminals.open-terminal")((payload) =>
          client("terminals.open-terminal", payload),
        ),
        "write-terminal": Effect.fn("CakeIpcClient.terminals.write-terminal")((payload) =>
          client("terminals.write-terminal", payload),
        ),
        "resize-terminal": Effect.fn("CakeIpcClient.terminals.resize-terminal")((payload) =>
          client("terminals.resize-terminal", payload),
        ),
        "get-terminal-status": Effect.fn("CakeIpcClient.terminals.get-terminal-status")((payload) =>
          client("terminals.get-terminal-status", payload),
        ),
        "close-terminal": Effect.fn("CakeIpcClient.terminals.close-terminal")((payload) =>
          client("terminals.close-terminal", payload),
        ),
        "close-working-directory-terminals": Effect.fn(
          "CakeIpcClient.terminals.close-working-directory-terminals",
        )((payload) => client("terminals.close-working-directory-terminals", payload)),
      },
      vscode: {
        observeState: () => client("vscode.observeState", undefined),
        "get-embedded-editor-state": Effect.fn("CakeIpcClient.vscode.get-embedded-editor-state")(
          (payload) => client("vscode.get-embedded-editor-state", payload),
        ),
        "set-vscode-server-path": Effect.fn("CakeIpcClient.vscode.set-vscode-server-path")(
          (payload) => client("vscode.set-vscode-server-path", payload),
        ),
        "install-embedded-editor": Effect.fn("CakeIpcClient.vscode.install-embedded-editor")(
          (payload) => client("vscode.install-embedded-editor", payload),
        ),
        "open-embedded-editor": Effect.fn("CakeIpcClient.vscode.open-embedded-editor")((payload) =>
          client("vscode.open-embedded-editor", payload),
        ),
        "update-embedded-editor-bounds": Effect.fn(
          "CakeIpcClient.vscode.update-embedded-editor-bounds",
        )((payload) => client("vscode.update-embedded-editor-bounds", payload)),
        "reveal-in-embedded-editor": Effect.fn("CakeIpcClient.vscode.reveal-in-embedded-editor")(
          (payload) => client("vscode.reveal-in-embedded-editor", payload),
        ),
        "open-embedded-editor-source-control": Effect.fn(
          "CakeIpcClient.vscode.open-embedded-editor-source-control",
        )((payload) => client("vscode.open-embedded-editor-source-control", payload)),
        "update-embedded-editor-annotations": Effect.fn(
          "CakeIpcClient.vscode.update-embedded-editor-annotations",
        )((payload) => client("vscode.update-embedded-editor-annotations", payload)),
      },
      events: {
        application: () => client("application.observeEvents", undefined),
        artifacts: () => client("artifacts.observeEvents", undefined),
        terminals: () => client("terminals.observeEvents", undefined),
        vscode: () => client("vscode.observeEvents", undefined),
        surfaces: () => client("electron.observeSurfaceEvents", undefined),
      },
      artifacts: {
        "respond-artifact": Effect.fn("CakeIpcClient.artifacts.respond-artifact")((payload) =>
          client("artifacts.respond-artifact", payload),
        ),
        "respond-ui": Effect.fn("CakeIpcClient.artifacts.respond-ui")((payload) =>
          client("artifacts.respond-ui", payload),
        ),
        "export-artifacts": Effect.fn("CakeIpcClient.artifacts.export-artifacts")((payload) =>
          client("artifacts.export-artifacts", payload),
        ),
        catalog: Effect.fn("CakeIpcClient.artifacts.catalog")((payload) =>
          client("artifacts.catalog", payload),
        ),
        effective: Effect.fn("CakeIpcClient.artifacts.effective")((sessionId) =>
          client("artifacts.effective", { sessionId }),
        ),
        detail: Effect.fn("CakeIpcClient.artifacts.detail")((lineageId) =>
          client("artifacts.detail", { lineageId }),
        ),
        history: Effect.fn("CakeIpcClient.artifacts.history")((payload) =>
          client("artifacts.history", payload),
        ),
        readExact: Effect.fn("CakeIpcClient.artifacts.readExact")((lineageId, revision) =>
          client("artifacts.readExact", { lineageId, revision }),
        ),
        referenceMetadata: Effect.fn("CakeIpcClient.artifacts.referenceMetadata")((reference) =>
          client("artifacts.referenceMetadata", { reference }),
        ),
        compareText: Effect.fn("CakeIpcClient.artifacts.compareText")(
          (lineageId, fromRevision, toRevision) =>
            client("artifacts.compareText", { lineageId, fromRevision, toRevision }),
        ),
        restore: Effect.fn("CakeIpcClient.artifacts.restore")((payload) =>
          client("artifacts.restore", payload),
        ),
        link: Effect.fn("CakeIpcClient.artifacts.link")((payload) =>
          client("artifacts.link", payload),
        ),
        unlink: Effect.fn("CakeIpcClient.artifacts.unlink")((payload) =>
          client("artifacts.unlink", payload),
        ),
        setSelection: Effect.fn("CakeIpcClient.artifacts.setSelection")((payload) =>
          client("artifacts.setSelection", payload),
        ),
        materialize: Effect.fn("CakeIpcClient.artifacts.materialize")(
          (sessionId, lineageId, revision) =>
            client("artifacts.materialize", { sessionId, lineageId, revision }),
        ),
      },
      widgets: {
        "compile-inline-widget": Effect.fn("CakeIpcClient.widgets.compile-inline-widget")(
          (payload) => client("widgets.compile-inline-widget", payload),
        ),
      },
      foundation: {
        typedFailure: Effect.fn("CakeIpcClient.foundation.typedFailure")(() =>
          client("foundation.typedFailure", undefined),
        ),
        stream: (input) => client("foundation.stream", input),
        delay: Effect.fn("CakeIpcClient.foundation.delay")((input) =>
          client("foundation.delay", input),
        ),
        activeRequests: Effect.fn("CakeIpcClient.foundation.activeRequests")(() =>
          client("foundation.activeRequests", undefined),
        ),
      },
    });
  }),
);
