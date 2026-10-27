import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem, platform, arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compare,
  distribution,
  metricNames,
  prepareAcceptance,
  validateRun,
  type Baseline,
  type Run,
} from "./regression.ts";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const mode = args.shift();
function option(name: string, fallback?: string) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing --${name}`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
  args.splice(index, 2);
  return value;
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path: string, value: unknown, exclusive = false) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", exclusive ? { flag: "wx" } : {});
const pnpm = (args: string[], env = process.env) => {
  const result = spawnSync("pnpm", args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(
      `pnpm ${args.join(" ")} failed (${result.status}); inspect retained traces/partial samples`,
    );
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const harnessFiles = [
  "tests/electron/user-performance.spec.ts",
  "tests/electron/fixtures/performance.ts",
  "tests/electron/main-harness.ts",
  "tests/fixtures/window-state.ts",
  "tests/fixtures/performance/v2.json",
  "playwright.performance.config.ts",
  "scripts/performance/user-performance.ts",
  "scripts/performance/regression.ts",
];
try {
  if (mode === "accept") {
    const source = option("run");
    const limitsPath = option("limits");
    const destination = option("baseline");
    const reviewer = option("reviewer");
    const rationale = option("rationale");
    if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    const baseline = prepareAcceptance(
      await readJson(source),
      await readJson(limitsPath),
      reviewer,
      rationale,
    );
    await mkdir(dirname(destination), { recursive: true });
    await writeJson(destination, baseline, true);
    console.log(
      `Created review candidate ${destination}. Commit/review explicitly; existing baselines are never overwritten.`,
    );
  } else if (mode === "collect" || mode === "check") {
    const profile = option("profile");
    const samples = Number(option("samples", "60"));
    const output = resolve(
      option("output", `.performance-captures/user-performance/${Date.now()}`),
    );
    const baselinePath = mode === "check" ? option("baseline") : undefined;
    if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    if (!Number.isInteger(samples) || samples < 1)
      throw new Error("--samples must be a positive integer");
    if (mode === "check" && samples < 60) throw new Error("Gating requires at least 60 samples");
    // Missing baselines fail before an expensive build; collect is the only non-gating mode.
    const baseline: Baseline | undefined = baselinePath
      ? await readJson(baselinePath).catch((error) => {
          throw new Error(
            `Cannot read accepted baseline ${baselinePath}: ${error.message}. Use collect for non-gating measurements.`,
          );
        })
      : undefined;
    const hash = createHash("sha256");
    for (const path of harnessFiles) hash.update(path).update(await readFile(join(root, path)));
    const version = async (name: string) =>
      (await readJson(join(root, "node_modules", name, "package.json"))).version as string;
    const run: Run = {
      schemaVersion: 1,
      fixtureVersion: "cake-desktop-v2-retained",
      metricVersion: "visible-readiness-v1",
      harnessHash: hash.digest("hex"),
      environment: {
        profile,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
        node: process.version,
        electron: await version("electron"),
        playwright: await version("@playwright/test"),
        display: "hidden",
        motion: "no-preference",
        viewport: "1440x1000",
      },
      revision: git("rev-parse", "HEAD"),
      dirty: Boolean(git("status", "--porcelain")),
      collectedAt: new Date().toISOString(),
      samplesPerMetric: samples,
      metrics: Object.fromEntries(
        metricNames.map((name) => [name, []]),
      ) as unknown as Run["metrics"],
    };
    // Validate compatibility before building by using reference sample payloads only for preflight.
    if (baseline) compare(baseline, { ...run, metrics: baseline.run.metrics });
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output);
    const runPath = join(output, "run.json");
    await writeJson(runPath, run);
    pnpm(["build:slim"]);
    pnpm(
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.performance.config.ts",
        `--output=${join(output, "evidence")}`,
      ],
      { ...process.env, CAKE_PERFORMANCE_RUN: runPath },
    );
    const completed: Run = await readJson(runPath);
    validateRun(completed, mode === "check");
    const summary = metricNames.map((metric) => ({
      metric,
      ...distribution(completed.metrics[metric].map((sample) => sample.ms)),
    }));
    await writeJson(join(output, "summary.json"), summary);
    console.table(summary);
    if (baseline) {
      const result = compare(baseline, completed);
      await writeJson(join(output, "comparison.json"), result);
      if (!result.passed) throw new Error(result.failures.join("\n"));
      console.log(
        "Performance comparison passed (compatible profile; measured reference AND absolute budgets).",
      );
    } else console.log("COLLECTION ONLY — not a regression gate or an accepted baseline.");
    console.log(`Evidence: ${output}`);
  } else
    throw new Error(
      "Usage: user-performance.ts collect|check --profile NAME [--samples 60] [--output DIR] [--baseline FILE]; accept --run FILE --limits FILE --baseline NEW_FILE --reviewer NAME --rationale TEXT",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
