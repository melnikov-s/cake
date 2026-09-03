import { Context, Effect, Layer, type Schema, type Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import { CakeRpc, type FoundationFailure } from "../protocol/CakeRpc";
import type { ArtifactError } from "../../domain/artifact-data";
import type { ElectronError } from "../../services/electron/Electron";
import type { PluginRuntimeError } from "../../services/plugins/PluginRuntime";
import type { TerminalError } from "../../services/terminal/Terminal";
import type { ManagedWorktreeError } from "../../services/worktrees/ManagedWorktrees";
import type { VsCodeServerError } from "../../services/vscode/VsCodeServer";
import type { WorkspaceFileError } from "../../services/filesystem/WorkspaceFiles";
import type { ProjectError } from "../../domain/project-error";
import type {
  CakeEvent as CakeEventEnvelope,
  CakeRpcOperation,
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../cake-rpc-contract";

import type {
  RendererApplicationProjection,
  RendererApplicationState,
} from "../../domain/application-data";
import type { AgentAvailabilitySnapshot } from "../../domain/agent-availability-data";
import type { CustomizationState } from "../../plugin/plugin-contract";
import type { PiSettingUpdate } from "../session-contract";
import type {
  ProjectSessionError,
  ProjectSessionCatalogQuery,
  ProjectSessionPreview,
  ProjectSessionPromptInput,
  ProjectSessionStartInput,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "../../domain/project-session-data";
import type { ConversationSnapshot, TurnId } from "../../domain/conversation-data";
import type {
  CakeChatConfiguration,
  CakeChatCatalogQuery,
  CakeChatError,
  CakeChatPreview,
  CakeChatPromptInput,
  CakeChatTarget,
  CakeChatUpdate,
} from "../../domain/cake-chat-data";
import type {
  DiscussionSessionCreateInput,
  DiscussionSessionError,
  DiscussionSessionPromptInput,
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
  DiscussionThread,
} from "../../domain/discussion-session-data";
import type {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/catalog-data";
import type { SubagentError, SubagentHandleId, SubagentUpdate } from "../../domain/subagent-data";
import type {
  DefaultModelPresetNotFoundError,
  DuplicateModelPresetIdError,
  ModelPresetCreateInput,
  ModelPresetLimitError,
  ModelPresetNotFoundError,
  ModelPresetProjection,
  ModelPresetUpdateInput,
  ModelPresetValidationError,
} from "../../domain/modelPresets";
import type {
  ModelSelection,
  PiModel,
  PiModelCatalogError,
  PiModelResolutionError,
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
  readonly models: {
    readonly list: () => Effect.Effect<
      ReadonlyArray<PiModel>,
      PiModelCatalogError | TransportError
    >;
    readonly refresh: () => Effect.Effect<void, PiModelCatalogError | TransportError>;
  };
  readonly modelPresets: {
    readonly list: () => Effect.Effect<ModelPresetProjection, TransportError>;
    readonly create: (
      input: ModelPresetCreateInput,
    ) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly update: (
      input: ModelPresetUpdateInput,
    ) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly remove: (id: string) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly setDefault: (
      id?: string,
    ) => Effect.Effect<ModelPresetProjection, ModelPresetMutationError>;
    readonly resolve: (id: string) => Effect.Effect<ModelSelection, ModelPresetResolutionError>;
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
    readonly prompt: (
      input: CakeChatPromptInput,
    ) => Effect.Effect<TurnId, CakeChatError | TransportError>;
    readonly abort: (target: CakeChatTarget) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly compact: (
      input: CakeChatTarget & { readonly instructions?: string },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly editMessage: (
      input: CakeChatPromptInput & { readonly entryId: string },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly applyConfiguration: (
      input: CakeChatTarget & { readonly configuration: CakeChatConfiguration },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly setModel: (
      input: CakeChatTarget & { readonly provider: string; readonly modelId: string },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly setThinkingLevel: (
      input: CakeChatTarget & { readonly level: CakeChatConfiguration["thinkingLevel"] },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly setFastMode: (
      input: CakeChatTarget & { readonly enabled: boolean },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly rename: (
      input: CakeChatTarget & { readonly name: string },
    ) => Effect.Effect<void, CakeChatError | TransportError>;
    readonly handoff: (
      input: CakeChatTarget & {
        readonly entryId: string;
        readonly prompt?: string;
        readonly resolveSource?: boolean;
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
    readonly create: (
      input: DiscussionSessionCreateInput,
    ) => Effect.Effect<DiscussionThread, DiscussionSessionError | TransportError>;
    readonly observe: (
      target: DiscussionSessionTarget,
    ) => Stream.Stream<DiscussionSessionUpdate, DiscussionSessionError | TransportError>;
    readonly prompt: (
      input: DiscussionSessionPromptInput,
    ) => Effect.Effect<
      { readonly turnId: TurnId; readonly thread: DiscussionThread },
      DiscussionSessionError | TransportError
    >;
    readonly abort: (
      target: DiscussionSessionTarget,
    ) => Effect.Effect<void, DiscussionSessionError | TransportError>;
    readonly setResolved: (
      target: DiscussionSessionTarget & { readonly resolved: boolean },
    ) => Effect.Effect<DiscussionThread, DiscussionSessionError | TransportError>;
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
    readonly prompt: (
      input: ProjectSessionPromptInput,
    ) => Effect.Effect<TurnId, ProjectSessionError | TransportError>;
    readonly steer: (
      input: ProjectSessionPromptInput,
    ) => Effect.Effect<TurnId, ProjectSessionError | TransportError>;
    readonly followUp: (
      input: ProjectSessionPromptInput,
    ) => Effect.Effect<TurnId, ProjectSessionError | TransportError>;
    readonly abort: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly compact: (
      input: ProjectSessionTarget & { readonly instructions?: string },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly editMessage: (
      input: ProjectSessionTarget &
        Pick<ProjectSessionPromptInput, "text" | "attachments" | "renderUserMessageAsMarkdown"> & {
          readonly entryId: string;
        },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly applyConfiguration: (
      input: ProjectSessionTarget & { readonly configuration: CakeChatConfiguration },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly setModel: (
      input: ProjectSessionTarget & { readonly provider: string; readonly modelId: string },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly setThinkingLevel: (
      input: ProjectSessionTarget & {
        readonly level: CakeChatConfiguration["thinkingLevel"];
      },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly setFastMode: (
      input: ProjectSessionTarget & { readonly enabled: boolean },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly getChangelog: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<string, ProjectSessionError | TransportError>;
    readonly navigate: (
      input: ProjectSessionTarget & { readonly entryId: string },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly setPiSetting: (
      input: ProjectSessionTarget & { readonly update: PiSettingUpdate },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly reload: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly login: (
      input: ProjectSessionTarget & {
        readonly provider: string;
        readonly authType: "api_key" | "oauth";
      },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly logout: (
      input: ProjectSessionTarget & { readonly provider: string },
    ) => Effect.Effect<void, ProjectSessionError | TransportError>;
    readonly handoff: (
      input: ProjectSessionTarget & {
        readonly entryId: string;
        readonly prompt?: string;
        readonly resolveSource?: boolean;
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
    | "remove-project"
    | "delete-session"
    | "set-session-unread"
    | "restart-pi"
    | "inspect-workspace"
    | "respond-workspace-trust",
    ProjectError
  >;
  readonly managedWorktrees: RpcOperations<
    "create-worktree" | "get-worktree-status" | "land-worktree" | "discard-worktree",
    ManagedWorktreeError
  >;
  readonly terminals: RpcOperations<
    | "open-terminal"
    | "write-terminal"
    | "resize-terminal"
    | "get-terminal-status"
    | "close-terminal",
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
  >;
  readonly plugins: RpcOperations<
    | "get-customization-state"
    | "get-plugin-authoring-reference"
    | "list-plugin-files"
    | "create-plugin"
    | "read-plugin-file"
    | "write-plugin-file"
    | "validate-customization"
    | "activate-customization"
    | "rollback-customization"
    | "use-factory-customization"
    | "list-plugins"
    | "set-plugin-enabled"
    | "set-active-scene"
    | "delete-plugin"
    | "compile-inline-widget"
    | "repair-inline-widget"
    | "open-plugin-agent"
    | "prompt-plugin-agent"
    | "abort-plugin-agent"
    | "detach-plugin-agent"
    | "run-plugin-completion"
    | "cancel-plugin-completion"
    | "load-plugin-state"
    | "save-plugin-state"
    | "call-plugin-backend"
    | "cancel-plugin-backend-call"
    | "customization-rendered"
    | "customization-runtime-failed",
    PluginRuntimeError
  > & {
    readonly observeCustomization: () => Stream.Stream<CustomizationState, TransportError>;
  };
  readonly events: {
    readonly application: () => Stream.Stream<
      FocusedCakeEvent<
        | "workspace-inspected"
        | "changelog-snapshot"
        | "complete"
        | "fatal"
        | "notification"
        | "extension-ui-intent"
        | "project-session-control-requested"
        | "renderer-events-ready"
      >,
      TransportError
    >;
    readonly artifacts: () => Stream.Stream<
      FocusedCakeEvent<
        "artifact-updated" | "artifact-requested" | "ui-request" | "renderer-events-ready"
      >,
      TransportError
    >;
    readonly plugins: () => Stream.Stream<
      FocusedCakeEvent<"plugin-backend-event" | "plugin-agent-event" | "renderer-events-ready">,
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
        | "embedded-editor-selection"
        | "embedded-editor-back-to-agent"
        | "embedded-editor-annotation-opened"
        | "embedded-editor-toggle-chat"
        | "embedded-editor-selection-cleared"
        | "embedded-editor-entered"
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
      models: {
        list: Effect.fn("CakeIpcClient.models.list")(() => client("models.list", undefined)),
        refresh: Effect.fn("CakeIpcClient.models.refresh")(() =>
          client("models.refresh", undefined),
        ),
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
      cakeChats: {
        observeCatalog: (input) => client("cakeChats.observeCatalog", input),
        inspect: Effect.fn("CakeIpcClient.cakeChats.inspect")((sessionId) =>
          client("cakeChats.inspect", { sessionId }),
        ),
        open: Effect.fn("CakeIpcClient.cakeChats.open")((target) =>
          client("cakeChats.open", target),
        ),
        observe: (target) => client("cakeChats.observe", target),
        prompt: Effect.fn("CakeIpcClient.cakeChats.prompt")((input) =>
          client("cakeChats.prompt", input),
        ),
        abort: Effect.fn("CakeIpcClient.cakeChats.abort")((target) =>
          client("cakeChats.abort", target),
        ),
        compact: Effect.fn("CakeIpcClient.cakeChats.compact")((input) =>
          client("cakeChats.compact", input),
        ),
        editMessage: Effect.fn("CakeIpcClient.cakeChats.editMessage")((input) =>
          client("cakeChats.editMessage", input),
        ),
        applyConfiguration: Effect.fn("CakeIpcClient.cakeChats.applyConfiguration")((input) =>
          client("cakeChats.applyConfiguration", input),
        ),
        setModel: Effect.fn("CakeIpcClient.cakeChats.setModel")((input) =>
          client("cakeChats.setModel", input),
        ),
        setThinkingLevel: Effect.fn("CakeIpcClient.cakeChats.setThinkingLevel")((input) =>
          client("cakeChats.setThinkingLevel", input),
        ),
        setFastMode: Effect.fn("CakeIpcClient.cakeChats.setFastMode")((input) =>
          client("cakeChats.setFastMode", input),
        ),
        rename: Effect.fn("CakeIpcClient.cakeChats.rename")((input) =>
          client("cakeChats.rename", input),
        ),
        handoff: Effect.fn("CakeIpcClient.cakeChats.handoff")((input) =>
          client("cakeChats.handoff", input),
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
        create: Effect.fn("CakeIpcClient.discussionSessions.create")((input) =>
          client("discussionSessions.create", input),
        ),
        observe: (target) => client("discussionSessions.observe", target),
        prompt: Effect.fn("CakeIpcClient.discussionSessions.prompt")((input) =>
          client("discussionSessions.prompt", input),
        ),
        abort: Effect.fn("CakeIpcClient.discussionSessions.abort")((target) =>
          client("discussionSessions.abort", target),
        ),
        setResolved: Effect.fn("CakeIpcClient.discussionSessions.setResolved")((target) =>
          client("discussionSessions.setResolved", target),
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
        prompt: Effect.fn("CakeIpcClient.projectSessions.prompt")((input) =>
          client("projectSessions.prompt", input),
        ),
        steer: Effect.fn("CakeIpcClient.projectSessions.steer")((input) =>
          client("projectSessions.steer", input),
        ),
        followUp: Effect.fn("CakeIpcClient.projectSessions.followUp")((input) =>
          client("projectSessions.followUp", input),
        ),
        abort: Effect.fn("CakeIpcClient.projectSessions.abort")((target) =>
          client("projectSessions.abort", target),
        ),
        compact: Effect.fn("CakeIpcClient.projectSessions.compact")((input) =>
          client("projectSessions.compact", input),
        ),
        editMessage: Effect.fn("CakeIpcClient.projectSessions.editMessage")((input) =>
          client("projectSessions.editMessage", input),
        ),
        applyConfiguration: Effect.fn("CakeIpcClient.projectSessions.applyConfiguration")((input) =>
          client("projectSessions.applyConfiguration", input),
        ),
        setModel: Effect.fn("CakeIpcClient.projectSessions.setModel")((input) =>
          client("projectSessions.setModel", input),
        ),
        setThinkingLevel: Effect.fn("CakeIpcClient.projectSessions.setThinkingLevel")((input) =>
          client("projectSessions.setThinkingLevel", input),
        ),
        setFastMode: Effect.fn("CakeIpcClient.projectSessions.setFastMode")((input) =>
          client("projectSessions.setFastMode", input),
        ),
        getChangelog: Effect.fn("CakeIpcClient.projectSessions.getChangelog")((target) =>
          client("projectSessions.getChangelog", target),
        ),
        navigate: Effect.fn("CakeIpcClient.projectSessions.navigate")((input) =>
          client("projectSessions.navigate", input),
        ),
        setPiSetting: Effect.fn("CakeIpcClient.projectSessions.setPiSetting")((input) =>
          client("projectSessions.setPiSetting", input),
        ),
        reload: Effect.fn("CakeIpcClient.projectSessions.reload")((target) =>
          client("projectSessions.reload", target),
        ),
        login: Effect.fn("CakeIpcClient.projectSessions.login")((input) =>
          client("projectSessions.login", input),
        ),
        logout: Effect.fn("CakeIpcClient.projectSessions.logout")((input) =>
          client("projectSessions.logout", input),
        ),
        handoff: Effect.fn("CakeIpcClient.projectSessions.handoff")((input) =>
          client("projectSessions.handoff", input),
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
        "create-worktree": Effect.fn("CakeIpcClient.managedWorktrees.create-worktree")((payload) =>
          client("managedWorktrees.create-worktree", payload),
        ),
        "get-worktree-status": Effect.fn("CakeIpcClient.managedWorktrees.get-worktree-status")(
          (payload) => client("managedWorktrees.get-worktree-status", payload),
        ),
        "land-worktree": Effect.fn("CakeIpcClient.managedWorktrees.land-worktree")((payload) =>
          client("managedWorktrees.land-worktree", payload),
        ),
        "discard-worktree": Effect.fn("CakeIpcClient.managedWorktrees.discard-worktree")(
          (payload) => client("managedWorktrees.discard-worktree", payload),
        ),
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
        plugins: () => client("plugins.observeEvents", undefined),
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
      },
      plugins: {
        observeCustomization: () => client("plugins.observeCustomization", undefined),
        "get-customization-state": Effect.fn("CakeIpcClient.plugins.get-customization-state")(
          (payload) => client("plugins.get-customization-state", payload),
        ),
        "get-plugin-authoring-reference": Effect.fn(
          "CakeIpcClient.plugins.get-plugin-authoring-reference",
        )((payload) => client("plugins.get-plugin-authoring-reference", payload)),
        "list-plugin-files": Effect.fn("CakeIpcClient.plugins.list-plugin-files")((payload) =>
          client("plugins.list-plugin-files", payload),
        ),
        "create-plugin": Effect.fn("CakeIpcClient.plugins.create-plugin")((payload) =>
          client("plugins.create-plugin", payload),
        ),
        "read-plugin-file": Effect.fn("CakeIpcClient.plugins.read-plugin-file")((payload) =>
          client("plugins.read-plugin-file", payload),
        ),
        "write-plugin-file": Effect.fn("CakeIpcClient.plugins.write-plugin-file")((payload) =>
          client("plugins.write-plugin-file", payload),
        ),
        "validate-customization": Effect.fn("CakeIpcClient.plugins.validate-customization")(
          (payload) => client("plugins.validate-customization", payload),
        ),
        "activate-customization": Effect.fn("CakeIpcClient.plugins.activate-customization")(
          (payload) => client("plugins.activate-customization", payload),
        ),
        "rollback-customization": Effect.fn("CakeIpcClient.plugins.rollback-customization")(
          (payload) => client("plugins.rollback-customization", payload),
        ),
        "use-factory-customization": Effect.fn("CakeIpcClient.plugins.use-factory-customization")(
          (payload) => client("plugins.use-factory-customization", payload),
        ),
        "list-plugins": Effect.fn("CakeIpcClient.plugins.list-plugins")((payload) =>
          client("plugins.list-plugins", payload),
        ),
        "set-plugin-enabled": Effect.fn("CakeIpcClient.plugins.set-plugin-enabled")((payload) =>
          client("plugins.set-plugin-enabled", payload),
        ),
        "set-active-scene": Effect.fn("CakeIpcClient.plugins.set-active-scene")((payload) =>
          client("plugins.set-active-scene", payload),
        ),
        "delete-plugin": Effect.fn("CakeIpcClient.plugins.delete-plugin")((payload) =>
          client("plugins.delete-plugin", payload),
        ),
        "compile-inline-widget": Effect.fn("CakeIpcClient.plugins.compile-inline-widget")(
          (payload) => client("plugins.compile-inline-widget", payload),
        ),
        "repair-inline-widget": Effect.fn("CakeIpcClient.plugins.repair-inline-widget")((payload) =>
          client("plugins.repair-inline-widget", payload),
        ),
        "open-plugin-agent": Effect.fn("CakeIpcClient.plugins.open-plugin-agent")((payload) =>
          client("plugins.open-plugin-agent", payload),
        ),
        "prompt-plugin-agent": Effect.fn("CakeIpcClient.plugins.prompt-plugin-agent")((payload) =>
          client("plugins.prompt-plugin-agent", payload),
        ),
        "abort-plugin-agent": Effect.fn("CakeIpcClient.plugins.abort-plugin-agent")((payload) =>
          client("plugins.abort-plugin-agent", payload),
        ),
        "detach-plugin-agent": Effect.fn("CakeIpcClient.plugins.detach-plugin-agent")((payload) =>
          client("plugins.detach-plugin-agent", payload),
        ),
        "run-plugin-completion": Effect.fn("CakeIpcClient.plugins.run-plugin-completion")(
          (payload) => client("plugins.run-plugin-completion", payload),
        ),
        "cancel-plugin-completion": Effect.fn("CakeIpcClient.plugins.cancel-plugin-completion")(
          (payload) => client("plugins.cancel-plugin-completion", payload),
        ),
        "load-plugin-state": Effect.fn("CakeIpcClient.plugins.load-plugin-state")((payload) =>
          client("plugins.load-plugin-state", payload),
        ),
        "save-plugin-state": Effect.fn("CakeIpcClient.plugins.save-plugin-state")((payload) =>
          client("plugins.save-plugin-state", payload),
        ),
        "call-plugin-backend": Effect.fn("CakeIpcClient.plugins.call-plugin-backend")((payload) =>
          client("plugins.call-plugin-backend", payload),
        ),
        "cancel-plugin-backend-call": Effect.fn("CakeIpcClient.plugins.cancel-plugin-backend-call")(
          (payload) => client("plugins.cancel-plugin-backend-call", payload),
        ),
        "customization-rendered": Effect.fn("CakeIpcClient.plugins.customization-rendered")(
          (payload) => client("plugins.customization-rendered", payload),
        ),
        "customization-runtime-failed": Effect.fn(
          "CakeIpcClient.plugins.customization-runtime-failed",
        )((payload) => client("plugins.customization-runtime-failed", payload)),
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
