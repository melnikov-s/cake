import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import QuietReporter from "./scripts/vitest-quiet-reporter";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src/renderer"),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.{ts,tsx}"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Suites launch real backends, browsers and bundlers; CPU-count parallelism
    // exhausts desktop resources and can time out unrelated process startups.
    maxWorkers: 1,
    reporters: [new QuietReporter()],
    testTimeout: 30_000,
  },
});
