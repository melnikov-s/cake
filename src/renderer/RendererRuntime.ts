import { type Effect, Layer, ManagedRuntime } from "effect";
import { type CakeIpcClient, CakeIpcClientLive } from "../ipc/client/CakeIpcClient";
import { makeElectronRpcClientProtocol } from "../ipc/transport/ElectronRpcClientProtocol";
import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";

const makeRendererLayer = (transport: ElectronRpcTransport) =>
  CakeIpcClientLive.pipe(Layer.provide(makeElectronRpcClientProtocol(transport)));

/** Window-owned execution boundary; the ManagedRuntime never escapes this module. */
export const makeRendererRuntime = (transport: ElectronRpcTransport) => {
  const runtime = ManagedRuntime.make(makeRendererLayer(transport));
  return {
    execute: <Success, Failure>(
      effect: Effect.Effect<Success, Failure, CakeIpcClient>,
      signal?: AbortSignal,
    ): Promise<Success> => runtime.runPromise(effect, signal ? { signal } : undefined),
    dispose: () => runtime.dispose(),
  };
};

export type RendererRuntime = ReturnType<typeof makeRendererRuntime>;
