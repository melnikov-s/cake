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
    coverage: { reporter: ["text", "html"] },
    include: ["tests/app/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    // Workflow tests render the full app in jsdom and take 2-4s alone. On a loaded machine or a
    // small CI runner they starve past the 5s default and fail at random, not on a real defect.
    testTimeout: 15_000,
    reporters: [new QuietReporter()],
  },
});
