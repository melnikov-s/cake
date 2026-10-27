import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Build an exported baseline, not another checkout/worktree or the user's installed app.
const root = resolve(import.meta.dirname, "..");
const revision = process.argv[2] ?? "e9947a7d";
const output = `.performance-captures/session-switching/${process.env.CAKE_PERFORMANCE_WORKLOAD ?? "warm"}`;
const baseline = await mkdtemp(join(tmpdir(), "cake-switching-baseline-"));
const run = (args, cwd, env = process.env) => {
  const result = spawnSync("pnpm", args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${result.status})`);
};
try {
  const archive = execFileSync("git", ["archive", "--format=tar", revision], {
    cwd: root,
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", baseline], { input: archive });
  const [currentLockfile, baselineLockfile] = await Promise.all([
    readFile(join(root, "pnpm-lock.yaml"), "utf8"),
    readFile(join(baseline, "pnpm-lock.yaml"), "utf8"),
  ]);
  // A changed package patch must not leak into the baseline through the shared
  // node_modules link. Materialize its exact locked dependencies from pnpm's cache.
  if (currentLockfile === baselineLockfile)
    await symlink(join(root, "node_modules"), join(baseline, "node_modules"), "dir");
  else run(["install", "--offline", "--frozen-lockfile"], baseline);
  run(["build:slim"], baseline);
  run(["build:slim"], root);
  run(
    [
      "exec",
      "playwright",
      "test",
      "tests/electron/session-switching.performance.spec.ts",
      `--output=${output}`,
    ],
    root,
    {
      ...process.env,
      CAKE_PERFORMANCE_BASELINE_APP: baseline,
      CAKE_PERFORMANCE_BASELINE_REVISION: execFileSync("git", ["rev-parse", revision], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      CAKE_PERFORMANCE_PATCHED_REVISION:
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() +
        (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()
          ? "+working-tree"
          : ""),
    },
  );
  const report = JSON.parse(await readFile(join(root, output, "summary.json"), "utf8"));
  console.log(JSON.stringify(report.comparison, null, 2));
  console.log(`Full report: ${output}/summary.json`);
} finally {
  await rm(baseline, { recursive: true, force: true });
}
