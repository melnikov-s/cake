import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import { CakeRpc, type FoundationFailure } from "../protocol/CakeRpc";
import { makeElectronRpcClientProtocol } from "../transport/ElectronRpcClientProtocol";
import type { ElectronRpcTransport } from "../transport/ElectronRpcTransport";
import type { ApplicationState } from "../../domain/application-data";

interface CakeIpcClientService {
  readonly application: {
    readonly getHomeDirectory: () => Effect.Effect<string, RpcClientError.RpcClientError>;
    readonly getState: () => Effect.Effect<ApplicationState, RpcClientError.RpcClientError>;
  };
  readonly foundation: {
    readonly typedFailure: () => Effect.Effect<
      void,
      FoundationFailure | RpcClientError.RpcClientError
    >;
    readonly stream: (input: {
      readonly count: number;
      readonly intervalMs: number;
    }) => Stream.Stream<number, RpcClientError.RpcClientError>;
    readonly delay: (input: {
      readonly durationMs: number;
    }) => Effect.Effect<void, RpcClientError.RpcClientError>;
    readonly activeRequests: () => Effect.Effect<
      { readonly delays: number; readonly streams: number },
      RpcClientError.RpcClientError
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
        getHomeDirectory: () => client("application.getHomeDirectory", undefined),
        getState: () => client("application.getState", undefined),
      },
      foundation: {
        typedFailure: () => client("foundation.typedFailure", undefined),
        stream: (input) => client("foundation.stream", input),
        delay: (input) => client("foundation.delay", input),
        activeRequests: () => client("foundation.activeRequests", undefined),
      },
    });
  }),
);

export interface CakeIpcPromiseClient {
  readonly application: {
    readonly getHomeDirectory: () => Promise<string>;
    readonly getState: () => Promise<ApplicationState>;
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
