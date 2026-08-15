import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginImportPolicyError, validatePluginImport } from "../../../src/main/plugin-import-policy";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-plugin-policy-"));
  roots.push(root);
  const pluginRoot = join(root, "plugin");
  await mkdir(join(pluginRoot, "ui"), { recursive: true });
  const importer = join(pluginRoot, "ui", "scene.tsx");
  const local = join(pluginRoot, "ui", "widget.tsx");
  await writeFile(importer, "");
  await writeFile(local, "");
  return { root, pluginRoot, importer, local };
}

describe("validatePluginImport", () => {
  it("accepts only the explicit shared runtime modules", async () => {
    const { pluginRoot, importer } = await fixture();
    await expect(validatePluginImport({ pluginRoot, importer, specifier: "react" })).resolves.toEqual({ kind: "shared", specifier: "react" });
    await expect(validatePluginImport({ pluginRoot, importer, specifier: "cake" })).resolves.toEqual({ kind: "shared", specifier: "cake" });
    await expect(validatePluginImport({ pluginRoot, importer, specifier: "node:fs" })).rejects.toBeInstanceOf(PluginImportPolicyError);
    await expect(validatePluginImport({ pluginRoot, importer, specifier: "r-state-tree/react" })).rejects.toThrow("bare module is not on Cake's allowlist");
  });

  it("accepts local files that resolve inside the plugin", async () => {
    const { pluginRoot, importer, local } = await fixture();
    await expect(validatePluginImport({ pluginRoot, importer, specifier: "./widget", resolvedPath: local })).resolves.toEqual({ kind: "local", path: await realpath(local) });
  });

  it("rejects lexical and absolute filesystem escapes", async () => {
    const { root, pluginRoot, importer } = await fixture();
    await expect(validatePluginImport({ pluginRoot, importer, specifier: "../../outside.ts" })).rejects.toThrow("relative import escapes");
    await expect(validatePluginImport({ pluginRoot, importer, specifier: join(root, "outside.ts") })).rejects.toThrow("absolute filesystem imports");
  });

  it("rejects symlink escapes after resolution", async () => {
    const { root, pluginRoot, importer } = await fixture();
    const outside = join(root, "outside.ts");
    const link = join(pluginRoot, "ui", "linked.ts");
    await writeFile(outside, "");
    await symlink(outside, link);
    await expect(validatePluginImport({ pluginRoot, importer, specifier: "./linked", resolvedPath: link })).rejects.toThrow("through a symlink");
  });
});
