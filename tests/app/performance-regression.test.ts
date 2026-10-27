import { describe, expect, it } from "vitest";
import {
  compare,
  distribution,
  metricNames,
  prepareAcceptance,
  validateRun,
  type Run,
  type Baseline,
} from "../../scripts/performance/regression";

const run = (ms = 100): Run => ({
  schemaVersion: 1,
  fixtureVersion: "fixture-v1",
  metricVersion: "metrics-v1",
  harnessHash: "abc",
  revision: "measured-revision",
  dirty: false,
  collectedAt: "2026-01-01T00:00:00Z",
  samplesPerMetric: 60,
  environment: {
    profile: "dedicated-test",
    platform: "darwin",
    release: "25",
    arch: "arm64",
    cpu: "Test CPU",
    cores: 8,
    memoryGiB: 16,
    node: "24",
    electron: "43",
    playwright: "1.62",
    display: "hidden",
    motion: "no-preference",
    viewport: "1440x1000",
  },
  metrics: Object.fromEntries(
    metricNames.map((name) => [
      name,
      Array.from({ length: 60 }, (_, iteration) => ({
        ms,
        iteration,
        longTasks: [],
        providerCalls: name === "message.feedback" ? 1 : 0,
      })),
    ]),
  ) as unknown as Run["metrics"],
});
// Synthetic numbers test arithmetic, NOT product budgets or accepted timing values.
const limits = (): Baseline["limits"] =>
  Object.fromEntries(
    metricNames.map((name) => [
      name,
      { relative: 0.2, noiseFloorMs: 15, medianBudgetMs: 200, p95BudgetMs: 250 },
    ]),
  ) as Baseline["limits"];
const accepted = () =>
  prepareAcceptance(run(), limits(), "test-reviewer", "Synthetic comparator test");

describe("performance comparison", () => {
  it("calculates median and nearest-rank p95 from unsorted repeated samples", () => {
    expect(distribution(Array.from({ length: 60 }, (_, i) => 60 - i))).toEqual({
      count: 60,
      median: 30.5,
      p95: 57,
    });
  });
  it("passes ordinary noise", () => expect(compare(accepted(), run(110)).passed).toBe(true));
  it("fails substantial slowdown with bounded actionable metric/stat evidence", () => {
    const result = compare(accepted(), run(160));
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(12);
    expect(result.failures[0]).toContain(
      "switch.cold.ready median: 160.0ms > regression limit 120.0ms",
    );
  });
  it("uses the absolute noise floor for near-zero timings", () => {
    const baseline = prepareAcceptance(run(2), limits(), "reviewer", "test");
    expect(compare(baseline, run(12)).passed).toBe(true);
    expect(compare(baseline, run(20)).passed).toBe(false);
  });
  it("fails absolute budget breach even without relative slowdown", () => {
    const baseline = accepted();
    baseline.limits["message.feedback"].p95BudgetMs = 105;
    const result = compare(baseline, run(110));
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["message.feedback p95: 110.0ms > absolute budget 105.0ms"]);
  });
  it("checks the p95 tail independently of the median", () => {
    const current = run();
    current.metrics["session.resolve"].slice(-4).forEach((sample) => {
      sample.ms = 180;
    });
    expect(compare(accepted(), current).failures).toEqual([
      "session.resolve p95: 180.0ms > regression limit 120.0ms (reference 100.0ms)",
    ]);
  });
  it("fails missing baseline with explicit collection guidance", () =>
    expect(() => compare(undefined, run())).toThrow(/Missing accepted baseline.*collect/));
  it.each(["fixtureVersion", "metricVersion", "harnessHash"] as const)(
    "rejects incompatible %s",
    (key) => {
      const current = run();
      current[key] = "different";
      expect(() => compare(accepted(), current)).toThrow(`Incompatible ${key}`);
    },
  );
  it.each(["profile", "cpu", "node", "electron", "release", "motion"] as const)(
    "rejects incomparable environment %s",
    (key) => {
      const current = run();
      Object.assign(current.environment, { [key]: "different" });
      expect(() => compare(accepted(), current)).toThrow(`Incompatible environment.${key}`);
    },
  );
  it("requires meaningful sample counts for gating but allows explicit smoke collection", () => {
    const small = run();
    small.samplesPerMetric = 3;
    metricNames.forEach((name) => {
      small.metrics[name] = small.metrics[name].slice(0, 3);
    });
    expect(() => validateRun(small, false)).not.toThrow();
    expect(() => compare(accepted(), small)).toThrow(/at least 60/);
    expect(() => prepareAcceptance(small, limits(), "r", "test")).toThrow(/at least 60/);
  });
  it("rejects incomplete, invalid and unordered sample evidence", () => {
    const current = run();
    current.metrics["composer.input"].pop();
    expect(() => compare(accepted(), current)).toThrow(/count mismatch/);
    expect(() => distribution([NaN])).toThrow(/finite/);
    expect(() => distribution([-1])).toThrow(/nonnegative/);
    const unordered = run();
    unordered.metrics["composer.input"][0]!.iteration = 4;
    expect(() => validateRun(unordered)).toThrow(/order/);
  });
  it("requires deliberate reviewed acceptance and calibrated budgets", () => {
    expect(() => prepareAcceptance(run(), limits(), "", "test")).toThrow(/reviewer/);
    expect(() => prepareAcceptance(run(), limits(), "reviewer", "")).toThrow(/rationale/);
    const dirty = run();
    dirty.dirty = true;
    expect(() => prepareAcceptance(dirty, limits(), "r", "test")).toThrow(/clean revision/);
    expect(() => prepareAcceptance(run(300), limits(), "r", "test")).toThrow(/violates budgets/);
    const missing = limits();
    delete (missing as Partial<typeof missing>)["composer.input"];
    expect(() => prepareAcceptance(run(), missing, "r", "test")).toThrow(/metric limits/);
  });
  it("rejects incomplete environment, misspelled limits and wrong provider evidence", () => {
    const incomplete = run();
    delete (incomplete.environment as Partial<typeof incomplete.environment>).cpu;
    expect(() => compare(accepted(), incomplete)).toThrow(/environment fields/);
    const badLimits = limits();
    Object.assign(badLimits["session.resolve"], { p95BugetMs: 250 });
    delete (badLimits["session.resolve"] as Partial<(typeof badLimits)["session.resolve"]>)
      .p95BudgetMs;
    expect(() => prepareAcceptance(run(), badLimits, "r", "test")).toThrow(
      /Invalid calibrated limits/,
    );
    const calls = run();
    calls.metrics["message.feedback"][0]!.providerCalls = 2;
    expect(() => validateRun(calls)).toThrow(/provider call count/);
  });
  it("requires identical sample counts even when both counts are sufficient", () => {
    const current = run();
    current.samplesPerMetric = 61;
    metricNames.forEach((name) =>
      current.metrics[name].push({ ...current.metrics[name][0]!, iteration: 60 }),
    );
    expect(() => compare(accepted(), current)).toThrow(/Incompatible samplesPerMetric/);
  });
  it("comparison never replaces or mutates the measured reference", () => {
    const baseline = accepted();
    const saved = JSON.stringify(baseline);
    compare(baseline, run(110));
    compare(baseline, run(300));
    expect(JSON.stringify(baseline)).toBe(saved);
  });
});
