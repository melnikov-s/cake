import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const cacheModule = pathToFileURL(
  resolve(import.meta.dirname, "../../scripts/native-build-cache.mjs"),
).href;

it("two build processes share one compilation across identical worktrees and create no local Swift scratch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-shared-native-"));
  try {
    for (const name of ["first", "second"]) {
      const source = join(root, name, "Sources");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "main.swift"), "identical Swift input");
    }
    const driver = join(root, "build.mjs");
    // Only the native compiler is faked. Hashing, locking, cache publication,
    // restaging and process coordination are the real implementation.
    await writeFile(
      driver,
      `
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildNativeBundle } from ${JSON.stringify(cacheModule)};
const root = process.argv[2], name = process.argv[3];
await buildNativeBundle({
  product: 'cake-helper', cacheRoot: join(root, 'cache'),
  inputs: [join(root, name, 'Sources')], output: join(root, name, 'out'),
  buildIdentity: 'fixture compiler/SDK',
  build: async (bundle, scratch) => {
    await appendFile(join(root, 'compiles'), scratch + '\\n');
    await writeFile(join(bundle, 'cake-helper'), 'compiled helper');
  },
});
`,
    );
    await Promise.all(
      ["first", "second"].map((name) => execute(process.execPath, [driver, root, name])),
    );
    const compiles = (await readFile(join(root, "compiles"), "utf8")).trim().split("\n");
    expect(compiles).toHaveLength(1);
    expect(compiles[0]).toContain(join(root, "cache", "cake-helper", "scratch"));
    for (const name of ["first", "second"]) {
      expect(await readFile(join(root, name, "out", "cake-helper"), "utf8")).toBe(
        "compiled helper",
      );
      expect(await readdir(join(root, name))).toEqual(["Sources", "out"]);
    }
    expect(await readdir(join(root, "cache", "cake-helper", "locks"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
