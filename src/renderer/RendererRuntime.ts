import { Layer, ManagedRuntime } from "effect";
import { CakeIpcClientLive } from "../ipc/client/CakeIpcClient";
import { makeElectronRpcClientProtocol } from "../ipc/transport/ElectronRpcClientProtocol";
import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";

const makeRendererLayer = (transport: ElectronRpcTransport) =>
  CakeIpcClientLive.pipe(Layer.provide(makeElectronRpcClientProtocol(transport)));

/** Low-level renderer Effect runtime shared by command and projection infrastructure. */
export const makeRendererRuntime = (transport: ElectronRpcTransport) =>
  ManagedRuntime.make(makeRendererLayer(transport));

export type RendererRuntime = ReturnType<typeof makeRendererRuntime>;
