import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/electron",
  testMatch: "user-performance.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { trace: "retain-on-failure" },
});
