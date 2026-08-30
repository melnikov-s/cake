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
    setupFiles: ["./tests/setup.ts"],
    reporters: [new QuietReporter()],
    testTimeout: 30_000,
  },
});
