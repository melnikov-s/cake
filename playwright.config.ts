import { defineConfig } from "@playwright/test";
import { queueElectronEntrypoint } from "./scripts/electron-run-queue.mjs";

// Config analysis (for example Knip) must not reserve an Electron run.
if (/[\\/](?:@playwright[\\/]test|playwright)[\\/]cli\.js$/.test(process.argv[1] ?? ""))
  await queueElectronEntrypoint();

export default defineConfig({
  reporter: "line",
  globalSetup: "./scripts/electron-playwright-setup.ts",
  testDir: "tests/electron",
  // Native desktop activation requires the separate foreground config, not an inherited env flag.
  grepInvert: /@foreground|@performance/,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
});
