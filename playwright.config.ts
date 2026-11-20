import { defineConfig } from "@playwright/test";
import { queueElectronEntrypoint } from "./scripts/electron-run-queue.mjs";

// Config analysis (for example Knip) must not reserve an Electron run.
// Whole-suite scripts raise the run deadline; targeted reruns keep the 30-minute default.
const deadlineMinutes = Number(process.env.CAKE_ELECTRON_RUN_TIMEOUT_MINUTES);
if (/[\\/](?:@playwright[\\/]test|playwright)[\\/]cli\.js$/.test(process.argv[1] ?? ""))
  await queueElectronEntrypoint(
    deadlineMinutes > 0 ? { timeoutMs: Math.round(deadlineMinutes * 60_000) } : {},
  );

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
