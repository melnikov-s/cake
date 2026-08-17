import type { CakeDesktopBridge } from "../ipc/desktop-ipc";
declare global {
  const __CAKE_ACTIVE_SCENE_PLUGIN_ID__: string | undefined;
  interface Window {
    cake?: CakeDesktopBridge;
  }
}

export {};
