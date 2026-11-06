import { _electron as playwrightElectron } from "@playwright/test";
import electronExecutable from "electron";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const executablePath = fileURLToPath(new URL("./electron-queue-executable.mjs", import.meta.url));

// The executable handshake, not app code after startup, registers detached
// Electron groups with the supervisor before any real application is started.
export const _electron = {
  async launch(options = {}) {
    const socketPath = process.env.CAKE_ELECTRON_QUEUE_SOCKET;
    if (!socketPath)
      throw new Error(
        "Use the repository Playwright config or `pnpm electron:run node <script>` to launch Electron.",
      );
    return playwrightElectron.launch({
      ...options,
      executablePath,
      env: {
        ...(options.env ?? process.env),
        CAKE_ELECTRON_QUEUE_SOCKET: socketPath,
        CAKE_QUEUED_ELECTRON_EXECUTABLE: options.executablePath ?? electronExecutable,
      },
    });
  },
};
