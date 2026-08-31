import { Context, Effect, Layer, Stream, type ManagedRuntime } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import { CakeRpc, type FoundationFailure } from "../protocol/CakeRpc";
import type { RendererApplicationState } from "../../domain/application-data";
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
  readonly models: {
    readonly list: () => Effect.Effect<
      ReadonlyArray<PiModel>,
      PiModelCatalogError | TransportError
    >;
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
  readonly projectSessions: {
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProjectSessionSummary>,
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
      models: {
        list: Effect.fn("CakeIpcClient.models.list")(() => client("models.list", undefined)),
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
      projectSessions: {
        list: Effect.fn("CakeIpcClient.projectSessions.list")(() =>
          client("projectSessions.list", undefined),
        ),
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

export interface CakeIpcPromiseClient {
  readonly application: {
    readonly getHomeDirectory: () => Promise<string>;
    readonly getState: () => Promise<RendererApplicationState>;
  };
  readonly models: {
    readonly list: () => Promise<ReadonlyArray<PiModel>>;
  };
  readonly projectSessions: {
    readonly list: () => Promise<ReadonlyArray<ProjectSessionSummary>>;
    readonly inspect: (target: ProjectSessionTarget) => Promise<ProjectSessionPreview>;
    readonly create: (input: ProjectSessionCreateInput) => Promise<ConversationSnapshot>;
    readonly open: (target: ProjectSessionTarget) => Promise<ConversationSnapshot>;
    readonly observe: (
      target: ProjectSessionTarget,
      listener: (update: ProjectSessionUpdate) => void,
    ) => () => void;
    readonly prompt: (input: ProjectSessionPromptInput) => Promise<TurnId>;
    readonly steer: (input: ProjectSessionPromptInput) => Promise<TurnId>;
    readonly followUp: (input: ProjectSessionPromptInput) => Promise<TurnId>;
    readonly abort: (target: ProjectSessionTarget) => Promise<void>;
    readonly rename: (target: ProjectSessionTarget & { readonly name: string }) => Promise<void>;
    readonly fork: (
      input: ProjectSessionTarget & {
        readonly entryId: string;
        readonly destinationWorkingDirectory?: string;
        readonly resolveSource?: boolean;
      },
    ) => Promise<{ readonly sessionId: string }>;
    readonly resolve: (target: ProjectSessionTarget) => Promise<void>;
    readonly restore: (target: ProjectSessionTarget) => Promise<void>;
  };
  readonly foundation: {
    readonly typedFailure: () => Promise<void>;
    readonly stream: (input: {
      readonly count: number;
      readonly intervalMs: number;
    }) => Promise<ReadonlyArray<number>>;
    readonly delay: (durationMs: number, signal?: AbortSignal) => Promise<void>;
    readonly activeRequests: () => Promise<{ readonly delays: number; readonly streams: number }>;
  };
}

export type CakeIpcRuntime = ManagedRuntime.ManagedRuntime<CakeIpcClient, never>;

export function makeCakeIpcPromiseClient(runtime: CakeIpcRuntime): CakeIpcPromiseClient {
  const run = <A, E>(effect: Effect.Effect<A, E, CakeIpcClient>, signal?: AbortSignal) =>
    runtime.runPromise(effect, signal ? { signal } : undefined);
  const withClient = <A, E>(
    operation: (client: CakeIpcClientService) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E, CakeIpcClient> => Effect.flatMap(CakeIpcClient, operation);

  return {
    application: {
      getHomeDirectory: () => run(withClient((client) => client.application.getHomeDirectory())),
      getState: () => run(withClient((client) => client.application.getState())),
    },
    models: {
      list: () => run(withClient((client) => client.models.list())),
    },
    projectSessions: {
      list: () => run(withClient((client) => client.projectSessions.list())),
      inspect: (target) => run(withClient((client) => client.projectSessions.inspect(target))),
      create: (input) => run(withClient((client) => client.projectSessions.create(input))),
      open: (target) => run(withClient((client) => client.projectSessions.open(target))),
      observe: (target, listener) => {
        const controller = new AbortController();
        void run(
          withClient((client) =>
            client.projectSessions
              .observe(target)
              .pipe(Stream.runForEach((update) => Effect.sync(() => listener(update)))),
          ),
          controller.signal,
        ).catch(() => undefined);
        return () => controller.abort();
      },
      prompt: (input) => run(withClient((client) => client.projectSessions.prompt(input))),
      steer: (input) => run(withClient((client) => client.projectSessions.steer(input))),
      followUp: (input) => run(withClient((client) => client.projectSessions.followUp(input))),
      abort: (target) => run(withClient((client) => client.projectSessions.abort(target))),
      rename: (input) => run(withClient((client) => client.projectSessions.rename(input))),
      fork: (input) => run(withClient((client) => client.projectSessions.fork(input))),
      resolve: (target) => run(withClient((client) => client.projectSessions.resolve(target))),
      restore: (target) => run(withClient((client) => client.projectSessions.restore(target))),
    },
    foundation: {
      typedFailure: () => run(withClient((client) => client.foundation.typedFailure())),
      stream: (input) =>
        run(withClient((client) => Stream.runCollect(client.foundation.stream(input)))),
      delay: (durationMs, signal) =>
        run(
          withClient((client) => client.foundation.delay({ durationMs })),
          signal,
        ),
      activeRequests: () => run(withClient((client) => client.foundation.activeRequests())),
    },
  };
}
