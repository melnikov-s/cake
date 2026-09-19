import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";

declare global {
  interface ImportMetaEnv {
    readonly VITE_TLDRAW_LICENSE_KEY?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  const __CAKE_ACTIVE_SCENE_PLUGIN_ID__: string | undefined;
  interface Window {
    cake?: { readonly rpc: ElectronRpcTransport };
  }
}

export {};
