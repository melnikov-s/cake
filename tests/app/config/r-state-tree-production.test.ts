import { readFile, readdir } from "node:fs/promises";
import { join, matchesGlob, resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

test("packaging excludes the optional inspector and unpacked extension but retains core and React", async () => {
  const configuration = await readFile(join(root, "electron-builder.yml"), "utf8");
  const exclusions = [...configuration.matchAll(/^\s+- "!([^"]+)"$/gm)].map((match) => match[1]!);
  const excluded = (path: string) => exclusions.some((pattern) => matchesGlob(path, pattern));
  const packageRoot = "node_modules/r-state-tree";
  const files: string[] = [];
  const collect = async (path: string) => {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await collect(child);
      else files.push(child);
    }
  };
  await collect(`${packageRoot}/devtools`);
  await collect(`${packageRoot}/dist/devtools`);
  for (const entry of await readdir(join(root, packageRoot, "dist")))
    if (entry.startsWith("devtools") && /\.(?:cjs|js)$/.test(entry))
      files.push(`${packageRoot}/dist/${entry}`);
  expect(files.some((path) => path.endsWith("extension/manifest.json"))).toBe(true);
  expect(files.some((path) => path.endsWith("devtools-mcp.cjs"))).toBe(true);
  for (const path of files) expect(excluded(path), path).toBe(true);
  for (const path of ["r-state-tree.js", "r-state-tree.cjs", "react.js", "react.cjs"])
    expect(excluded(`${packageRoot}/dist/${path}`), path).toBe(false);
});
