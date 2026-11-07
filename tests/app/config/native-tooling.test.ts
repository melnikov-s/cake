import { describe, expect, it } from "vitest";
import manifest from "../../../package.json";
import compiler from "typescript/package.json";
import tsconfig from "../../../tsconfig.json";

describe("native validation tooling", () => {
  it("pins a stable native TypeScript release without shipping a runtime compiler API", () => {
    expect(manifest.devDependencies.typescript).toMatch(/^7\.\d+\.\d+$/);
    expect(compiler.version).toBe(manifest.devDependencies.typescript);
    expect(compiler.optionalDependencies).toHaveProperty(
      "@typescript/typescript-linux-x64",
      compiler.version,
    );
    expect(manifest.dependencies).not.toHaveProperty("typescript");
    expect(manifest.scripts.typecheck).toBe("tsc --noEmit");
    expect(tsconfig.compilerOptions).not.toHaveProperty("baseUrl");
    expect(tsconfig.compilerOptions.paths["@/*"]).toEqual(["./src/renderer/*"]);
  });

  it("runs Oxlint and unused-code checks without an ESLint pipeline or dependencies", () => {
    expect(manifest.scripts.lint).toBe("pnpm lint:oxlint && pnpm lint:knip");
    expect(manifest.scripts).not.toHaveProperty("lint:eslint");
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      for (const name of Object.keys(dependencies))
        expect(name).not.toMatch(/eslint|typescript\/native-preview/);
    }
  });
});
