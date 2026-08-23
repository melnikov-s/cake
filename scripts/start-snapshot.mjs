import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "out");
const runsRoot = join(tmpdir(), "cake-snapshot-runs");

async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function removeAbandonedRuns() {
  await mkdir(runsRoot, { recursive: true });
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(runsRoot, entry.name);
    let owner;
    try {
      owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    } catch {
      // An interrupted setup has no live owner and is safe to remove.
    }
    if (await processIsAlive(owner?.pid)) continue;
    await rm(path, { recursive: true, force: true });
  }
}

async function outputSignature() {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const metadata = await stat(path);
        files.push([relative(output, path), metadata.size, metadata.mtimeMs]);
      }
    }
  };
  await visit(output);
  files.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(files);
}

async function createStableSnapshot(runDirectory) {
  for (;;) {
    try {
      const before = await outputSignature();
      await rm(join(runDirectory, "out"), { recursive: true, force: true });
      await cp(output, join(runDirectory, "out"), { recursive: true });
      const after = await outputSignature();
      if (before === after) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    console.log("[cake] Build output changed while preparing the launch snapshot; retrying.");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

await stat(join(output, "main", "main.js")).catch(() => {
  throw new Error("Cake has not been built. Run `pnpm build` before `pnpm start`.");
});

await removeAbandonedRuns();
const runDirectory = join(runsRoot, `${process.pid}-${randomUUID()}`);
await mkdir(runDirectory, { recursive: true });
await writeFile(
  join(runDirectory, "owner.json"),
  `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
);

let child;
try {
  await createStableSnapshot(runDirectory);
  await cp(join(root, "package.json"), join(runDirectory, "package.json"));
  await symlink(
    join(root, "node_modules"),
    join(runDirectory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  child = spawn(electron, [runDirectory], {
    stdio: "inherit",
    env: { ...process.env, CAKE_AUTHORING_ROOT: root },
  });

  const forwardSignal = (signal) => {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 0)));
  });
  process.exitCode = exitCode;
} finally {
  if (child?.exitCode === null && !child.killed) child.kill("SIGTERM");
  await rm(runDirectory, { recursive: true, force: true });
}
