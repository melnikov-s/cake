import { describe, expect, it } from "vitest";
import manifest from "../../../package.json";
import compiler from "typescript/package.json";
import tsconfig from "../../../tsconfig.json";
import { validationCommands } from "../../../scripts/validation-run.mjs";
import knip from "../../../knip";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

describe("native validation tooling", () => {
  it("pins a stable native TypeScript release without shipping a runtime compiler API", () => {
    expect(manifest.devDependencies.typescript).toMatch(/^7\.\d+\.\d+$/);
    expect(compiler.version).toBe(manifest.devDependencies.typescript);
    expect(compiler.optionalDependencies).toHaveProperty(
      "@typescript/typescript-linux-x64",
      compiler.version,
    );
    expect(manifest.dependencies).not.toHaveProperty("typescript");
    expect(manifest.scripts.typecheck).toBe("node scripts/validation-run.mjs typecheck");
    expect(validationCommands.typecheck?.steps).toEqual([["tsc", "--noEmit"]]);
    expect(tsconfig.compilerOptions).not.toHaveProperty("baseUrl");
    expect(tsconfig.compilerOptions.paths["@/*"]).toEqual(["./src/renderer/*"]);
  });

  it("exposes queued validation commands to unused-code analysis without executing them", () => {
    expect(knip.vite.config).toContain("vite.browser.config.ts");
    expect(knip.vitest.config).toContain("vitest.integration.config.ts");
    expect(knip.entry).toEqual(
      expect.arrayContaining([
        "tests/fixtures/validation-queue-client.mjs",
        "tests/fixtures/validation-queue-job.mjs",
      ]),
    );
    const source = "// validation registry";
    const compile = knip.compilers[".mjs"];
    const path = resolve(import.meta.dirname, "../../../scripts/validation-run.mjs");
    const compiled = compile(source, path);

    expect(compiled).toContain(source);
    expect(compiled).toContain('import { spawnSync } from "node:child_process";');
    for (const { steps } of Object.values(validationCommands)) {
      for (const [command, ...args] of steps) {
        const rootedArgs = args.map((arg) => {
          const absolute = resolve(import.meta.dirname, "../../..", arg);
          return existsSync(absolute) ? absolute : arg;
        });
        expect(compiled).toContain(
          `spawnSync(${JSON.stringify(command)}, ${JSON.stringify(rootedArgs)});`,
        );
      }
    }
    expect(compiled).toContain(
      `spawnSync("node", [${JSON.stringify(resolve(import.meta.dirname, "../../../scripts/build.mjs"))},"full"]);`,
    );
    expect(compile(source, resolve(import.meta.dirname, "../../../scripts/build.mjs"))).toBe(
      source,
    );
    expect(compile(source, resolve(import.meta.dirname, "../../../other/validation-run.mjs"))).toBe(
      source,
    );
  });

  it("runs Oxlint and unused-code checks without an ESLint pipeline or dependencies", () => {
    expect(manifest.scripts.lint).toBe("node scripts/validation-run.mjs lint");
    expect(validationCommands.lint?.steps).toEqual([
      ["pnpm", "lint:oxlint"],
      ["pnpm", "lint:knip"],
    ]);
    expect(manifest.scripts).not.toHaveProperty("lint:eslint");
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      for (const name of Object.keys(dependencies))
        expect(name).not.toMatch(/eslint|typescript\/native-preview/);
    }
  });
});
