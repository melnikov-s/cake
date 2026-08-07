import type { CakeDesktopBridge } from "../ipc/desktop-ipc";

declare global {
  interface Window {
    cake?: CakeDesktopBridge;
  }
}

export {};
