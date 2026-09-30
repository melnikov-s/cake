import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

// Build an exported baseline, not another checkout/worktree or the user's installed app.
const root = resolve(import.meta.dirname, "..");
const revision = process.argv[2] ?? "e9947a7d";
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
  await symlink(join(root, "node_modules"), join(baseline, "node_modules"), "dir");
  run(["build"], baseline);
  run(["build"], root);
  run(
    [
      "exec",
      "playwright",
      "test",
      "tests/electron/session-switching.performance.spec.ts",
      "--output=.performance-captures/session-switching",
    ],
    root,
    {
      ...process.env,
      CAKE_PERFORMANCE_BASELINE_APP: baseline,
      CAKE_PERFORMANCE_BASELINE_REVISION: execFileSync("git", ["rev-parse", revision], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      CAKE_PERFORMANCE_PATCHED_REVISION: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    },
  );
  const report = JSON.parse(
    await readFile(join(root, ".performance-captures/session-switching/summary.json"), "utf8"),
  );
  console.log(JSON.stringify(report.comparison, null, 2));
  console.log("Full report: .performance-captures/session-switching/summary.json");
} finally {
  await rm(baseline, { recursive: true, force: true });
}
