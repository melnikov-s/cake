import { Layer, ManagedRuntime } from "effect";
import { CakeIpcClientLive, type CakeIpcRuntime } from "../ipc/client/CakeIpcClient";
import { makeElectronRpcClientProtocol } from "../ipc/transport/ElectronRpcClientProtocol";
import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";

const makeRendererLive = (transport: ElectronRpcTransport) =>
  CakeIpcClientLive.pipe(Layer.provide(makeElectronRpcClientProtocol(transport)));

export const makeRendererRuntime = (transport: ElectronRpcTransport): CakeIpcRuntime =>
  ManagedRuntime.make(makeRendererLive(transport));
