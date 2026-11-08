import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { KnipConfig } from "knip";
import { validationCommands } from "./scripts/validation-run.mjs";

export default {
  entry: [
    "playwright.foreground.config.ts",
    "playwright.performance.config.ts",
    "src/renderer/index.html",
    "src/assets/vscode-companion/extension.js",
    "src/server/main.ts",
    "scripts/visual-capture/cli.ts",
    "scripts/performance/session-references.ts",
    "scripts/performance/session-list.mjs",
    "scripts/performance/backend-amplification.mjs",
    "tests/integration/fixtures/headless-backend.ts",
    "tests/integration/fixtures/restart-backend.ts",
    // Forked dynamically by the Node validation-queue suite.
    "tests/fixtures/validation-queue-client.mjs",
    "tests/fixtures/validation-queue-job.mjs",
  ],
  // Configs reached through the queue must be loaded before graph analysis so
  // these plugins discover browser HTML, test includes, setup and global setup.
  vite: { config: ["vite.config.ts", "vite.browser.config.ts"] },
  vitest: { config: ["vitest.config.ts", "vitest.integration.config.ts"] },
  ignore: [".agents/skills/**/assets/**"],
  ignoreDependencies: ["vscode"],
  ignoreBinaries: ["swift"],
  ignoreExportsUsedInFile: false,
  compilers: {
    ".mjs": (source: string, path: string) => {
      if (resolve(path) !== resolve(import.meta.dirname, "scripts/validation-run.mjs"))
        return source;

      // Knip understands literal spawn calls, not our queued command registry.
      // Expose the same commands for analysis only; nothing here executes them.
      const commands = Object.values(validationCommands).flatMap(({ steps }) =>
        steps.map(([command, ...args]) => {
          // Knip resolves spawned paths from this module's directory, while the
          // validation runner executes them from the repository root.
          const rootedArgs = args.map((arg) => {
            const absolute = resolve(import.meta.dirname, arg);
            return existsSync(absolute) ? absolute : arg;
          });
          return `spawnSync(${JSON.stringify(command)}, ${JSON.stringify(rootedArgs)});`;
        }),
      );
      return `${source}\nimport { spawnSync } from "node:child_process";\n${commands.join("\n")}\n`;
    },
  },
} satisfies KnipConfig;
