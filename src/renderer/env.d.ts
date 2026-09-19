import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";

declare global {
  const __CAKE_ACTIVE_SCENE_PLUGIN_ID__: string | undefined;
  interface Window {
    cake?: { readonly rpc: ElectronRpcTransport };
  }
}

export {};
