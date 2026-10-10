/* global process, console */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { release } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Capture the selected compiler/SDK rather than assuming Xcode never changes. */
export async function swiftBuildIdentity() {
  const commands = [
    ["--find", "swift"],
    ["swift", "--version"],
    ["--show-sdk-path"],
    ["--show-sdk-version"],
  ];
  const toolchain = await Promise.all(
    commands.map(async (args) => (await execute("xcrun", args)).stdout.trim()),
  );
  const environment = Object.fromEntries(
    [
      "DEVELOPER_DIR",
      "TOOLCHAINS",
      "SDKROOT",
      "SWIFT_EXEC",
      "CC",
      "CXX",
      "MACOSX_DEPLOYMENT_TARGET",
      "SWIFTFLAGS",
      "CFLAGS",
      "CXXFLAGS",
      "CPPFLAGS",
      "LDFLAGS",
    ].map((name) => [name, process.env[name] ?? ""]),
  );
  return JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    os: release(),
    toolchain,
    environment,
  });
}

async function filesAt(path, base = path) {
  const metadata = await stat(path);
  if (metadata.isDirectory()) {
    const files = [];
    for (const name of (await readdir(path)).sort())
      files.push(...(await filesAt(join(path, name), base)));
    return files;
  }
  return [
    {
      path: relative(base, path),
      mode: metadata.mode & 0o777,
      hash: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    },
  ];
}

async function inputKey(inputs, buildIdentity) {
  const hash = createHash("sha256").update(buildIdentity);
  for (const input of inputs) hash.update(JSON.stringify([input, await filesAt(input)]));
  return hash.digest("hex");
}

async function isCached(cache, key) {
  try {
    const saved = JSON.parse(await readFile(join(cache, "manifest.json"), "utf8"));
    return (
      saved.key === key &&
      JSON.stringify(saved.files) === JSON.stringify(await filesAt(join(cache, "bundle")))
    );
  } catch (error) {
    if (error instanceof SyntaxError || error.code === "ENOENT") return false;
    throw error;
  }
}

/** Worktree-local native bundle cache. Always restage into Vite's disposable out/.
 * Content hashes ignore timestamp-only touches and detect changed/missing artifacts.
 * Build failures never mark a cache entry complete or overwrite the last good bundle.
 */
export async function buildNativeBundle({
  packagePath,
  product,
  output,
  inputs,
  buildIdentity,
  build,
  force = false,
}) {
  const scratch = join(packagePath, ".build");
  const cache = join(scratch, `cake-bundle-${product}`);
  const key = await inputKey(inputs, buildIdentity);
  if (!force && (await isCached(cache, key))) {
    console.log(`[cake] Reusing cached ${product} (native inputs unchanged)`);
  } else {
    console.log(
      `[cake] Building ${product} (${force ? "explicit native rebuild requested" : "native inputs/toolchain changed or cache missing"})`,
    );
    await mkdir(scratch, { recursive: true });
    const staged = await mkdtemp(join(scratch, `.cake-bundle-${product}-`));
    try {
      const bundle = join(staged, "bundle");
      await mkdir(bundle);
      await build(bundle);
      if ((await inputKey(inputs, buildIdentity)) !== key)
        throw new Error(`Native inputs changed while building ${product}; run the build again.`);
      await writeFile(
        join(staged, "manifest.json"),
        JSON.stringify({ key, files: await filesAt(bundle) }),
      );
      await rm(cache, { recursive: true, force: true });
      await rename(staged, cache);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  await mkdir(output, { recursive: true });
  const bundle = join(cache, "bundle");
  for (const name of await readdir(bundle)) {
    await rm(join(output, name), { recursive: true, force: true });
    await cp(join(bundle, name), join(output, name), { recursive: true });
  }
}
