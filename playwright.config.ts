import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: "line",
  testDir: "tests/electron",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
});
