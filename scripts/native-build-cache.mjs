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
import { basename, join, relative, resolve } from "node:path";
import { homedir, release } from "node:os";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

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
  // Input roles/order and relative source layout matter; the checkout's absolute path does not.
  for (const input of inputs) hash.update(JSON.stringify([basename(input), await filesAt(input)]));
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

/** Serialize identical builds across processes. Different input keys have separate scratch trees.
 * A crashed owner's lock is reported, never silently removed while an orphan compiler may run.
 */
async function withBuildLock(lock, run) {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = Number(await readFile(join(lock, "pid"), "utf8"));
        if (Number.isInteger(owner) && owner > 0) process.kill(owner, 0);
      } catch (cause) {
        if (cause.code === "ESRCH")
          throw new Error(
            `Stale native build lock: ${lock}. Stop remaining native builds before removing this lock.`,
            { cause },
          );
        if (cause.code !== "ENOENT" && cause.code !== "EPERM") throw cause;
      }
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for native build lock: ${lock}`, { cause: error });
      await delay(100);
    }
  }
  try {
    await writeFile(join(lock, "pid"), String(process.pid));
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Shared, content-addressed native cache. Neither bundles nor Swift scratch live in a worktree.
 * Always restage into disposable out/. Failed builds keep earlier successful entries intact.
 */
export async function buildNativeBundle({
  product,
  output,
  inputs,
  buildIdentity,
  build,
  force = false,
  cacheRoot = resolve(
    process.env.CAKE_NATIVE_CACHE ||
      join(process.env.CAKE_HOME || join(homedir(), ".cake"), "cache", "native-builds", "v1"),
  ),
}) {
  const key = await inputKey(inputs, buildIdentity);
  const root = join(cacheRoot, product);
  const bundles = join(root, "bundles");
  const cache = join(bundles, key);
  const scratch = join(root, "scratch", key);
  const locks = join(root, "locks");
  await mkdir(bundles, { recursive: true });
  await mkdir(locks, { recursive: true });
  await withBuildLock(join(locks, key), async () => {
    if (!force && (await isCached(cache, key))) {
      console.log(`[cake] Reusing shared cached ${product} (native inputs unchanged)`);
    } else {
      console.log(
        `[cake] Building ${product} (${force ? "explicit native rebuild requested" : "native inputs/toolchain changed or cache missing"})`,
      );
      await mkdir(scratch, { recursive: true });
      const staged = await mkdtemp(join(bundles, `.staged-${key}-`));
      try {
        const bundle = join(staged, "bundle");
        await mkdir(bundle);
        await build(bundle, scratch);
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
  });
}
