import type { CakeDesktopApi } from "@cake/protocol";

declare global {
  interface Window {
    cake?: CakeDesktopApi;
  }
}

export {};
