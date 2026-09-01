import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCakePaths } from "../../src/config/CakePaths";
import { PluginBuildService } from "../../src/services/plugins/plugin-build-service";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const sourceRoot = resolve(import.meta.dirname, "../..");

describe("PluginBuildService", () => {
  it("typechecks and builds one complete renderer graph containing plugin contributions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-build-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const plugin = join(paths.plugins, "example.calendar");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, "cake-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "example.calendar",
        name: "Example Calendar",
        renderer: "index.tsx",
      }),
    );
    await writeFile(
      join(plugin, "index.tsx"),
      `import { definePlugin, usePluginAgent, usePluginCompletion } from "cake";\nconst Badge = () => { const agent = usePluginAgent(); const completion = usePluginCompletion(); return <i data-agent={agent.status} data-completion={completion.status}>PLUGIN_BUILD_MARKER</i>; };\nexport default definePlugin({ id: "example.calendar", contributions: { Badge }, slots: { "global.sidebar.header": [{ id: "badge", component: Badge }] } });\n`,
    );
    const candidate = await new PluginBuildService(paths, sourceRoot).buildCandidate();
    expect(candidate.diagnostics).toEqual([]);
    expect(candidate.revision).not.toBe(candidate.sourceRevision);
    await access(candidate.indexHtml);
    await access(join(candidate.directory, "cake-build.json"));
    expect(await new PluginBuildService(paths, sourceRoot).isBuildCurrent(candidate.revision)).toBe(
      true,
    );
    const assets = join(candidate.directory, "assets");
    const scripts = (await readdir(assets)).filter((name) => name.endsWith(".js"));
    const output = (
      await Promise.all(scripts.map((name) => readFile(join(assets, name), "utf8")))
    ).join("\n");
    expect(output).toContain("PLUGIN_BUILD_MARKER");
    expect(output).not.toMatch(/from\s*["']react["']/);
  }, 20_000);

  it("bundles an unrestricted Node backend separately from the renderer", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-build-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const plugin = join(paths.plugins, "example.backend");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, "cake-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "example.backend",
        name: "Example Backend",
        backend: "backend.ts",
      }),
    );
    await writeFile(
      join(plugin, "backend.ts"),
      `import { readFile } from "node:fs/promises";\nimport { definePluginBackend } from "cake/backend";\nexport default definePluginBackend({ methods: { async inspect() { await readFile(new URL(import.meta.url)); return { marker: "UNRESTRICTED_BACKEND" }; } } });\n`,
    );
    const service = new PluginBuildService(paths, sourceRoot);
    const candidate = await service.buildCandidate();
    expect(candidate.diagnostics).toEqual([]);
    expect(candidate.backends).toEqual([
      { pluginId: "example.backend", path: expect.stringMatching(/example\.backend\.mjs$/) },
    ]);
    expect(await readFile(candidate.backends[0]!.path, "utf8")).toContain("UNRESTRICTED_BACKEND");
    expect(await service.backendEntries(candidate.revision)).toEqual(candidate.backends);
  }, 20_000);
});
