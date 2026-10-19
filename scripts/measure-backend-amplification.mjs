/* global process */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

// Provider-free, synthetic production-path audit. No running backend or user data.
// Usage: node scripts/measure-backend-amplification.mjs [artifacts|sessions|large|all]
// "large" keeps history at 100 MiB but raises the roster to 1,600 sessions / 800 families.
const mode = process.argv[2] ?? "all";
if (!["artifacts", "sessions", "large", "all"].includes(mode)) throw new Error("Unknown mode");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "cake-amplification-bundle-"));
try {
  const bundle = join(directory, "workload.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/performance/backend-amplification.mjs"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    loader: { ".md": "text" },
  });
  await symlink(join(root, "node_modules"), join(directory, "node_modules"));
  const result = spawnSync(process.execPath, [bundle, mode], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
