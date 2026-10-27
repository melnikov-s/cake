import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { metricNames } from "../../scripts/performance/regression";

const root = resolve(import.meta.dirname, "../..");
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["scripts/performance/user-performance.ts", ...args], {
    cwd: root,
    encoding: "utf8",
  });

it("CLI requires explicit acceptance and refuses to overwrite an existing reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-performance-cli-"));
  try {
    const run = join(directory, "run.json");
    const limits = join(directory, "limits.json");
    const destination = join(directory, "baseline.json");
    // Entirely synthetic arithmetic evidence, never a product baseline.
    await writeFile(
      run,
      JSON.stringify({
        schemaVersion: 1,
        fixtureVersion: "test",
        metricVersion: "test",
        harnessHash: "test",
        revision: "test",
        dirty: false,
        collectedAt: "2026-01-01",
        samplesPerMetric: 60,
        environment: {
          profile: "test",
          platform: "darwin",
          release: "test",
          arch: "arm64",
          cpu: "test",
          cores: 8,
          memoryGiB: 16,
          node: "test",
          electron: "test",
          playwright: "test",
          display: "hidden",
          motion: "no-preference",
          viewport: "1440x1000",
        },
        metrics: Object.fromEntries(
          metricNames.map((name) => [
            name,
            Array.from({ length: 60 }, (_, iteration) => ({
              ms: 10,
              iteration,
              longTasks: [],
              providerCalls: name === "message.feedback" ? 1 : 0,
            })),
          ]),
        ),
      }),
    );
    await writeFile(
      limits,
      JSON.stringify(
        Object.fromEntries(
          metricNames.map((name) => [
            name,
            { relative: 0.2, noiseFloorMs: 5, medianBudgetMs: 50, p95BudgetMs: 100 },
          ]),
        ),
      ),
    );
    const args = ["accept", "--run", run, "--limits", limits, "--baseline", destination];
    const missingReview = cli(...args);
    expect(missingReview.status).toBe(1);
    expect(missingReview.stderr).toContain("Missing --reviewer");
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const reviewed = [...args, "--reviewer", "test-reviewer", "--rationale", "Synthetic CLI test"];
    expect(cli(...reviewed).status).toBe(0);
    const saved = await readFile(destination, "utf8");
    const second = cli(...reviewed);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("EEXIST");
    expect(await readFile(destination, "utf8")).toBe(saved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("check mode fails a missing baseline before building or creating output", async () => {
  const result = cli(
    "check",
    "--profile",
    "test",
    "--baseline",
    "tests/fixtures/performance/baselines/nonexistent.json",
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Cannot read accepted baseline");
  expect(result.stderr).toContain("collect for non-gating");
  expect(result.stdout).not.toContain("build:slim");
});
