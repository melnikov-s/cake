import { Context, Effect, Layer, type Schema, type Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import { CakeRpc, type FoundationFailure } from "../protocol/CakeRpc";
import type { RendererApplicationState } from "../../domain/application-data";
import type { PiSettingUpdate } from "../session-contract";
import type {
  ProjectSessionCreateInput,
  ProjectSessionError,
  ProjectSessionPreview,
  ProjectSessionPromptInput,
  ProjectSessionSummary,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "../../domain/project-session-data";
import type { ConversationSnapshot, TurnId } from "../../domain/conversation-data";
import type {
  CakeChatConfiguration,
  CakeChatError,
  CakeChatPreview,
  CakeChatPromptInput,
  CakeChatSummary,
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
    readonly list: () => Effect.Effect<
      ReadonlyArray<CakeChatSummary>,
      CakeChatError | TransportError
    >;
    readonly observeCatalog: () => Stream.Stream<
      CakeChatCatalogUpdate,
      CakeChatError | TransportError
    >;
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
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProjectSessionSummary>,
      ProjectSessionError | TransportError
    >;
    readonly observeCatalog: () => Stream.Stream<
      SessionCatalogUpdate,
      ProjectSessionError | TransportError
    >;
    readonly inspect: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<ProjectSessionPreview, ProjectSessionError | TransportError>;
    readonly create: (
      input: ProjectSessionCreateInput,
    ) => Effect.Effect<ConversationSnapshot, ProjectSessionError | TransportError>;
    readonly open: (
      target: ProjectSessionTarget,
    ) => Effect.Effect<ConversationSnapshot, ProjectSessionError | TransportError>;
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
        list: Effect.fn("CakeIpcClient.cakeChats.list")(() => client("cakeChats.list", undefined)),
        observeCatalog: () => client("cakeChats.observeCatalog", undefined),
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
        list: Effect.fn("CakeIpcClient.projectSessions.list")(() =>
          client("projectSessions.list", undefined),
        ),
        observeCatalog: () => client("projectSessions.observeCatalog", undefined),
        inspect: Effect.fn("CakeIpcClient.projectSessions.inspect")((target) =>
          client("projectSessions.inspect", target),
        ),
        create: Effect.fn("CakeIpcClient.projectSessions.create")((input) =>
          client("projectSessions.create", input),
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
