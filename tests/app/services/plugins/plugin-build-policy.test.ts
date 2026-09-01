import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCakePaths } from "../../../../src/config/CakePaths";
import { PluginBuildService } from "../../../../src/services/plugins/plugin-build-service";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("PluginBuildService policy gates", () => {
  it("returns source-mapped type diagnostics instead of emitting a candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-build-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const plugin = join(paths.plugins, "example.broken");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, "cake-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "example.broken",
        name: "Example Broken",
        renderer: "index.tsx",
      }),
    );
    await writeFile(
      join(plugin, "index.tsx"),
      `const wrong: number = "no"; export default wrong;\n`,
    );
    const candidate = await new PluginBuildService(
      paths,
      resolve(import.meta.dirname, "../../../.."),
    ).buildCandidate();
    expect(candidate.directory).toBe("");
    expect(
      candidate.diagnostics.some(
        (item) => item.phase === "typecheck" && item.message.includes("index.tsx:1"),
      ),
    ).toBe(true);
  }, 20_000);

  it("applies the constrained import policy to a plugin-owned scene", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-build-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const plugin = join(paths.plugins, "example.scene");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, "cake-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "example.scene",
        name: "Example Scene",
        scene: "scene.tsx",
        activeScene: true,
      }),
    );
    await writeFile(
      join(plugin, "scene.tsx"),
      `import "node:fs";\nexport default function Scene() { return null; }\n`,
    );
    const candidate = await new PluginBuildService(
      paths,
      resolve(import.meta.dirname, "../../../.."),
    ).buildCandidate();
    expect(candidate.directory).toBe("");
    expect(candidate.diagnostics.some((item) => item.message.includes("node:fs"))).toBe(true);
  });
});
