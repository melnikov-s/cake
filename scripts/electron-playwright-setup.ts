import type { FullConfig } from "@playwright/test";

export default function setup(config: FullConfig) {
  if (config.workers !== 1)
    throw new Error("Electron runs require --workers=1; parallel runners share the machine queue.");
  if (!process.env.CAKE_ELECTRON_QUEUE_SOCKET)
    throw new Error("Electron Playwright runs must use the shared run queue.");
}
