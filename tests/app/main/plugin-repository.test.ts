import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCakePaths } from "../../../src/main/cake-paths";
import { PluginRepository } from "../../../src/main/plugin-repository";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("PluginRepository", () => {
  it("uses the core default scene when no plugin scene is active and revisions source changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
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
    await writeFile(join(plugin, "index.tsx"), "export default {}\n");

    const repository = new PluginRepository(paths);
    const first = await repository.inspect();
    expect(first.plugins.map((item) => item.manifest.id)).toEqual(["example.calendar"]);
    expect(await repository.listPluginStatuses()).toEqual([
      expect.objectContaining({ id: "example.calendar", name: "Example Calendar", enabled: true }),
    ]);
    expect(first.scene).toBeUndefined();
    await repository.snapshotSource(first);
    await access(
      join(paths.recovery, "sources", first.revision, "plugins", "example.calendar", "index.tsx"),
    );
    await writeFile(join(plugin, "index.tsx"), "export default { changed: true }\n");
    expect((await repository.inspect()).revision).not.toBe(first.revision);
  });

  it("retains discovery diagnostics without loading invalid plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    await mkdir(join(paths.plugins, "bad.plugin"), { recursive: true });
    await writeFile(join(paths.plugins, "bad.plugin", "cake-plugin.json"), "{}\n");
    const result = await new PluginRepository(paths).inspect();
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ phase: "discovery" });
  });

  it("requires at least one executable entry in a v2 manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    await mkdir(join(paths.plugins, "empty.plugin"), { recursive: true });
    await writeFile(
      join(paths.plugins, "empty.plugin", "cake-plugin.json"),
      JSON.stringify({ schemaVersion: 2, id: "empty.plugin", name: "Empty" }),
    );
    const result = await new PluginRepository(paths).inspect();
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("renderer, a backend, a scene");
  });

  it("provides revision-checked, in-root source authoring", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const plugin = join(paths.plugins, "example.authoring");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, "cake-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "example.authoring",
        name: "Example Authoring",
        renderer: "index.tsx",
      }),
    );
    await writeFile(join(plugin, "index.tsx"), "export default {}\n");
    const repository = new PluginRepository(paths);
    const before = await repository.authoringSnapshot();
    expect(before.files).toContain("plugins/example.authoring/index.tsx");
    const after = await repository.writePluginFile(
      "example.authoring",
      "index.tsx",
      "export default { repaired: true }\n",
      before.workingRevision,
    );
    expect(after.workingRevision).not.toBe(before.workingRevision);
    expect(after.buildRevision).not.toBe(before.buildRevision);
    expect(await repository.readPluginFile("example.authoring", "index.tsx")).toContain("repaired");
    await expect(
      repository.writePluginFile(
        "example.authoring",
        "other.tsx",
        "broken",
        before.workingRevision,
      ),
    ).rejects.toThrow("working tree changed");
    await expect(
      repository.readPluginFile("example.authoring", "../../outside.tsx"),
    ).rejects.toThrow("escapes");
  });

  it("scaffolds plugin-owned capabilities and selects at most one scene", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const repository = new PluginRepository(paths);
    const initial = await repository.authoringSnapshot();
    await repository.createPlugin(
      { id: "example.scene", name: "Example Scene", renderer: true, backend: false, scene: true },
      initial.workingRevision,
    );

    expect(await repository.readPluginFile("example.scene", "cake-plugin.json")).toContain(
      '"activeScene": false',
    );
    expect((await repository.inspect()).scene).toBeUndefined();
    await repository.setActiveScene("example.scene");
    const selected = await repository.inspect();
    expect(selected.scenePluginId).toBe("example.scene");
    expect(selected.scene).toMatch(/\/plugins\/example\.scene\/scene\.tsx$/);
    await repository.setActiveScene();
    expect((await repository.inspect()).scene).toBeUndefined();
  });

  it("serializes optimistic writes so the same revision cannot win twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const repository = new PluginRepository(paths);
    const before = await repository.authoringSnapshot();
    await repository.createPlugin(
      { id: "example.one", name: "One", renderer: true, backend: false, scene: false },
      before.workingRevision,
    );
    const current = await repository.authoringSnapshot();
    const results = await Promise.allSettled([
      repository.writePluginFile(
        "example.one",
        "one.tsx",
        "export default 1\n",
        current.workingRevision,
      ),
      repository.writePluginFile(
        "example.one",
        "two.tsx",
        "export default 2\n",
        current.workingRevision,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects authoring through a plugin-directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(paths.plugins, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await symlink(outside, join(paths.plugins, "example.escape"));
    const repository = new PluginRepository(paths);
    const snapshot = await repository.authoringSnapshot();
    await expect(
      repository.writePluginFile("example.escape", "index.tsx", "no", snapshot.workingRevision),
    ).rejects.toThrow("does not match");
  });

  it("deletes only a validated plugin directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const plugin = join(paths.plugins, "example.removable");
    await mkdir(plugin, { recursive: true });
    await writeFile(
      join(plugin, "cake-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "example.removable",
        name: "Example Removable",
        renderer: "index.tsx",
        enabled: true,
      }),
    );
    await writeFile(join(plugin, "index.tsx"), "export default {}\n");

    const repository = new PluginRepository(paths);
    const result = await repository.deletePlugin("example.removable");
    expect(result).toEqual({ wasEnabled: true, plugins: [] });
    await expect(access(plugin)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to delete a plugin-directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(paths.plugins, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(
      join(outside, "cake-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        id: "example.escape",
        name: "Example Escape",
        renderer: "index.tsx",
      }),
    );
    await symlink(outside, join(paths.plugins, "example.escape"));

    await expect(new PluginRepository(paths).deletePlugin("example.escape")).rejects.toThrow(
      "does not match",
    );
    await access(outside);
  });

  it("lists and deletes a plugin with an invalid manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-plugin-repository-"));
    roots.push(root);
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(root, "cake") },
      homeDirectory: join(root, "home"),
    });
    const plugin = join(paths.plugins, "example.broken");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "cake-plugin.json"), "{}\n");

    const repository = new PluginRepository(paths);
    expect(await repository.listPluginStatuses()).toEqual([
      expect.objectContaining({
        id: "example.broken",
        enabled: false,
        diagnostics: [expect.anything()],
      }),
    ]);
    expect(await repository.deletePlugin("example.broken")).toEqual({
      wasEnabled: false,
      plugins: [],
    });
    await expect(access(plugin)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
