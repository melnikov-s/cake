import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCakePaths } from "../../../src/main/cake-paths";
import { PluginBuildService } from "../../../src/main/plugin-build-service";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("PluginBuildService", () => {
  it("typechecks and builds one complete renderer graph containing plugin contributions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-build-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    const plugin = join(paths.plugins, "example.calendar");
    await mkdir(plugin, { recursive: true }); await mkdir(paths.scenes, { recursive: true });
    await writeFile(join(plugin, "cake-plugin.json"), JSON.stringify({ schemaVersion: 1, id: "example.calendar", name: "Example Calendar", entry: "index.tsx" }));
    await writeFile(join(plugin, "index.tsx"), `import { definePlugin } from "cake";\nexport default definePlugin({ id: "example.calendar", contributions: { Badge: () => <i>PLUGIN_BUILD_MARKER</i> } });\n`);
    await writeFile(join(paths.scenes, "global.tsx"), `import type { ReactNode } from "react";\nimport calendar from "plugin:example.calendar";\nconst Badge = calendar.contributions.Badge;\nexport default function Scene({ children }: { children: ReactNode }) { return <><Badge />{children}</>; }\n`);
    const candidate = await new PluginBuildService(paths, resolve(import.meta.dirname, "../../..")).buildCandidate();
    expect(candidate.diagnostics).toEqual([]);
    expect(candidate.revision).not.toBe(candidate.sourceRevision);
    await access(candidate.indexHtml);
    await access(join(candidate.directory, "cake-build.json"));
    expect(await new PluginBuildService(paths, resolve(import.meta.dirname, "../../..")).isBuildCurrent(candidate.revision)).toBe(true);
    const assets = join(candidate.directory, "assets");
    const scripts = (await readdir(assets)).filter((name) => name.endsWith(".js"));
    const output = (await Promise.all(scripts.map((name) => readFile(join(assets, name), "utf8")))).join("\n");
    expect(output).toContain("PLUGIN_BUILD_MARKER");
    expect(output).not.toMatch(/from\s*["']react["']/);
  }, 20_000);

  it("returns source-mapped type diagnostics instead of emitting a candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-build-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    const plugin = join(paths.plugins, "example.broken");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "cake-plugin.json"), JSON.stringify({ schemaVersion: 1, id: "example.broken", name: "Example Broken", entry: "index.tsx" }));
    await writeFile(join(plugin, "index.tsx"), `const wrong: number = "no"; export default wrong;\n`);
    const candidate = await new PluginBuildService(paths, resolve(import.meta.dirname, "../../..")).buildCandidate();
    expect(candidate.directory).toBe("");
    expect(candidate.diagnostics.some((item) => item.phase === "typecheck" && item.message.includes("index.tsx:1"))).toBe(true);
  });

  it("applies the constrained import policy to global-scene source", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-build-")); roots.push(root);
    const paths = resolveCakePaths({ env: { CAKE_HOME: join(root, "cake") }, homeDirectory: join(root, "home") });
    await mkdir(paths.scenes, { recursive: true });
    await writeFile(join(paths.scenes, "global.tsx"), `import type { ReactNode } from "react";\nimport "node:fs";\nexport default function Scene({ children }: { children: ReactNode }) { return children; }\n`);
    const candidate = await new PluginBuildService(paths, resolve(import.meta.dirname, "../../..")).buildCandidate();
    expect(candidate.directory).toBe("");
    expect(candidate.diagnostics.some((item) => item.phase === "bundle" && item.message.includes("bare module is not on Cake's allowlist"))).toBe(true);
  });
});
