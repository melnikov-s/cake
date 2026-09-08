import { Layer, ManagedRuntime, type Stream } from "effect";
import { CakeIpcClientLive, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import { makeElectronRpcClientProtocol } from "../ipc/transport/ElectronRpcClientProtocol";
import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";
import {
  observeStream,
  type ExecuteRendererEffect,
  type StreamOptions,
} from "./observers/observe-stream";

const makeRendererLayer = (transport: ElectronRpcTransport) =>
  CakeIpcClientLive.pipe(Layer.provide(makeElectronRpcClientProtocol(transport)));

/** Window-owned execution boundary; the ManagedRuntime never escapes this module. */
export const makeRuntime = (transport: ElectronRpcTransport) => {
  const runtime = ManagedRuntime.make(makeRendererLayer(transport));
  const execute: ExecuteRendererEffect = (effect, signal) =>
    runtime.runPromise(effect, signal ? { signal } : undefined);
  return {
    execute,
    observe: <Value>(
      source: (client: CakeIpcClientService) => Stream.Stream<Value, unknown>,
      consume: (value: Value) => void,
      options: StreamOptions,
    ) => observeStream(execute, source, consume, options),
    dispose: () => runtime.dispose(),
  };
};

export type Runtime = ReturnType<typeof makeRuntime>;
