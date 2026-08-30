import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import { CakeRpc, type FoundationFailure } from "../protocol/CakeRpc";
import { makeElectronRpcClientProtocol } from "../transport/ElectronRpcClientProtocol";
import type { ElectronRpcTransport } from "../transport/ElectronRpcTransport";
import type { RendererApplicationState } from "../../domain/application-data";
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

interface CakeIpcClientService {
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

class CakeIpcClient extends Context.Service<CakeIpcClient, CakeIpcClientService>()(
  "cake/ipc/client/CakeIpcClient",
) {}

const CakeIpcClientLive = Layer.effect(
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
  readonly modelPresets: {
    readonly list: () => Promise<ModelPresetProjection>;
    readonly create: (input: ModelPresetCreateInput) => Promise<ModelPresetProjection>;
    readonly update: (input: ModelPresetUpdateInput) => Promise<ModelPresetProjection>;
    readonly remove: (id: string) => Promise<ModelPresetProjection>;
    readonly setDefault: (id?: string) => Promise<ModelPresetProjection>;
    readonly resolve: (id: string) => Promise<ModelSelection>;
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
  readonly dispose: () => Promise<void>;
}

export function makeCakeIpcPromiseClient(transport: ElectronRpcTransport): CakeIpcPromiseClient {
  const live = CakeIpcClientLive.pipe(Layer.provide(makeElectronRpcClientProtocol(transport)));
  const runtime = ManagedRuntime.make(live);
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
    modelPresets: {
      list: () => run(withClient((client) => client.modelPresets.list())),
      create: (input) => run(withClient((client) => client.modelPresets.create(input))),
      update: (input) => run(withClient((client) => client.modelPresets.update(input))),
      remove: (id) => run(withClient((client) => client.modelPresets.remove(id))),
      setDefault: (id) => run(withClient((client) => client.modelPresets.setDefault(id))),
      resolve: (id) => run(withClient((client) => client.modelPresets.resolve(id))),
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
    dispose: () => runtime.dispose(),
  };
}
