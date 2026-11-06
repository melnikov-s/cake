import { defineConfig } from "@playwright/test";
import { queueElectronEntrypoint } from "./scripts/electron-run-queue.mjs";

// Config analysis (for example Knip) must not reserve an Electron run.
if (/[\\/](?:@playwright[\\/]test|playwright)[\\/]cli\.js$/.test(process.argv[1] ?? ""))
  await queueElectronEntrypoint();

export default defineConfig({
  testDir: "tests/electron",
  globalSetup: "./scripts/electron-playwright-setup.ts",
  testMatch: "user-performance.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { trace: "retain-on-failure" },
});
