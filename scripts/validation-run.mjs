/* global process, console */
import { fileURLToPath } from "node:url";
import { isValidationRun, runInherited, runValidationCommand } from "./validation-queue.mjs";

// One source of truth for maintained validation commands. Steps are sequential;
// nested pnpm scripts inherit the same admission. Extra CLI args go to the final
// step, matching the old shell-script semantics without quoting/interpolation.
export const validationCommands = {
  build: { priority: 2, steps: [["node", "scripts/build.mjs", "full"]] },
  "build:slim": { priority: 2, steps: [["node", "scripts/build.mjs", "slim"]] },
  "dist:mac": {
    priority: 2,
    steps: [
      ["pnpm", "build"],
      ["pnpm", "package:mac"],
    ],
  },
  "package:mac": { priority: 2, steps: [["node", "scripts/package-mac.mjs"]] },
  "build:dictation": { priority: 2, steps: [["node", "scripts/build-dictation.mjs"]] },
  "build:speech": { priority: 2, steps: [["node", "scripts/build-speech.mjs"]] },
  "build:server": {
    priority: 2,
    steps: [
      ["node", "scripts/build-server.mjs"],
      ["vite", "build", "--config", "vite.browser.config.ts"],
    ],
  },
  "build:browser": {
    priority: 2,
    steps: [["vite", "build", "--config", "vite.browser.config.ts"]],
  },
  format: { priority: 0, steps: [["oxfmt", "."]] },
  "format:check": { priority: 0, steps: [["oxfmt", "--check", "."]] },
  lint: {
    priority: 1,
    steps: [
      ["pnpm", "lint:oxlint"],
      ["pnpm", "lint:knip"],
    ],
  },
  "lint:knip": { priority: 1, steps: [["knip"]] },
  "lint:oxlint": { priority: 0, steps: [["oxlint", "src"]] },
  "lint:anti-slop:audit": { priority: 1, steps: [["oxlint", "."]] },
  "theme:build": {
    priority: 1,
    steps: [
      ["node", "scripts/generate-vscode-theme.mjs"],
      ["oxfmt", "src/assets/vscode-companion/themes"],
    ],
  },
  test: { priority: 2, steps: [["vitest", "run"]] },
  "test:integration": {
    priority: 2,
    steps: [["vitest", "run", "--config", "vitest.integration.config.ts"]],
  },
  "test:validation": {
    priority: 0,
    steps: [["node", "--test", "--test-concurrency=1", "tests/tooling/validation-queue.test.mjs"]],
  },
  "test:dictation:native": {
    priority: 2,
    steps: [
      [
        "swift",
        "run",
        "--package-path",
        "native/dictation",
        "-c",
        "release",
        "dictation-protocol-tests",
      ],
    ],
  },
  "test:electron": {
    priority: 2,
    steps: [
      ["pnpm", "build:slim"],
      ["node", "scripts/build-server.mjs"],
      ["playwright", "test"],
    ],
  },
  "test:electron:full": {
    priority: 2,
    steps: [
      ["pnpm", "build"],
      ["node", "scripts/build-server.mjs"],
      ["playwright", "test"],
    ],
  },
  "test:electron:run": { priority: 2, steps: [["playwright", "test"]] },
  "test:packaged": {
    priority: 2,
    steps: [["playwright", "test", "tests/electron/packaged-app.smoke.spec.ts"]],
  },
  "perf:collect": {
    priority: 2,
    steps: [["node", "scripts/performance/user-performance.ts", "collect"]],
  },
  "perf:check": {
    priority: 2,
    steps: [["node", "scripts/performance/user-performance.ts", "check"]],
  },
  "measure:session-switch": {
    priority: 2,
    steps: [["node", "scripts/measure-session-switching.mjs"]],
  },
  "measure:session-references": {
    priority: 2,
    steps: [["node", "scripts/measure-session-references.mjs"]],
  },
  "measure:session-list": { priority: 2, steps: [["node", "scripts/measure-session-list.mjs"]] },
  "measure:backend-amplification": {
    priority: 2,
    steps: [["node", "scripts/measure-backend-amplification.mjs"]],
  },
  typecheck: { priority: 1, steps: [["tsc", "--noEmit"]] },
  "visual:capture": { priority: 2, steps: [["node", "scripts/visual-capture/run.mjs"]] },
};

export function validationPriority(name, args) {
  if (
    (name === "test" || name === "test:integration") &&
    ((args[0] && !args[0].startsWith("-")) ||
      args.some((arg) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg)) ||
      args.some(
        (arg) =>
          arg === "-t" || arg === "--testNamePattern" || arg.startsWith("--testNamePattern="),
      ))
  )
    return name === "test" ? 0 : 1;
  return validationCommands[name]?.priority ?? 1;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] === modulePath) {
  let [name, ...args] = process.argv.slice(2);
  if (args[0] === "--") args = args.slice(1);
  try {
    if (name === "--") {
      const [command, ...childArgs] = args;
      if (!command) throw new Error("Usage: pnpm validation:run -- <command> [args...]");
      process.exitCode = await runValidationCommand(command, childArgs, { label: command });
    } else {
      const entry = validationCommands[name];
      if (!entry) throw new Error(`Unknown validation script: ${name}`);
      if (isValidationRun()) {
        for (const [index, step] of entry.steps.entries()) {
          const [command, ...stepArgs] = step;
          const code = await runInherited(command, [
            ...stepArgs,
            ...(index === entry.steps.length - 1 ? args : []),
          ]);
          if (code !== 0) {
            process.exitCode = code;
            break;
          }
        }
      } else {
        process.exitCode = await runValidationCommand(
          process.execPath,
          [modulePath, name, ...args],
          {
            priority: validationPriority(name, args),
            label: `pnpm ${name}`,
          },
        );
      }
    }
  } catch (error) {
    console.error(`[cake:validation] ${error.message}`);
    process.exitCode = 1;
  }
}
