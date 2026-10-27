export const metricNames = [
  "switch.cold.ready",
  "switch.warm.ready",
  "composer.input",
  "session.resolve",
  "session.restore",
  "message.feedback",
] as const;
export type Metric = (typeof metricNames)[number];
export type Sample = { ms: number; iteration: number; longTasks: number[]; providerCalls: number };
type Environment = {
  profile: string;
  platform: string;
  release: string;
  arch: string;
  cpu: string;
  cores: number;
  memoryGiB: number;
  node: string;
  electron: string;
  playwright: string;
  display: "hidden";
  motion: "no-preference";
  viewport: string;
};
export type Run = {
  schemaVersion: 1;
  fixtureVersion: string;
  metricVersion: string;
  harnessHash: string;
  environment: Environment;
  revision: string;
  dirty: boolean;
  collectedAt: string;
  samplesPerMetric: number;
  metrics: Record<Metric, Sample[]>;
};
type Limit = {
  relative: number;
  noiseFloorMs: number;
  medianBudgetMs: number;
  p95BudgetMs: number;
};
export type Baseline = {
  schemaVersion: 1;
  acceptedBy: string;
  rationale: string;
  run: Run;
  limits: Record<Metric, Limit>;
};
const minimumSamples = 60;

export function distribution(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("Timing samples must be finite, nonnegative and nonempty");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

export function validateRun(run: Run, gating = true) {
  if (run.schemaVersion !== 1 || !run.fixtureVersion || !run.metricVersion || !run.harnessHash)
    throw new Error("Invalid run versions");
  if (
    !run.revision ||
    !run.collectedAt ||
    typeof run.dirty !== "boolean" ||
    !run.environment?.profile
  )
    throw new Error("Missing run provenance/environment");
  const fields: (keyof Environment)[] = [
    "profile",
    "platform",
    "release",
    "arch",
    "cpu",
    "cores",
    "memoryGiB",
    "node",
    "electron",
    "playwright",
    "display",
    "motion",
    "viewport",
  ];
  if (Object.keys(run.environment).sort().join() !== fields.sort().join())
    throw new Error("Incomplete environment fields");
  for (const value of Object.values(run.environment))
    if (value === "" || value === undefined || value === null)
      throw new Error("Incomplete environment");
  if (
    !Number.isInteger(run.samplesPerMetric) ||
    run.samplesPerMetric < (gating ? minimumSamples : 1)
  )
    throw new Error(`Need at least ${gating ? minimumSamples : 1} samples per metric`);
  if (!run.metrics || Object.keys(run.metrics).sort().join() !== [...metricNames].sort().join())
    throw new Error("Missing or unexpected metrics");
  for (const name of metricNames) {
    const samples = run.metrics[name];
    if (samples.length !== run.samplesPerMetric) throw new Error(`Sample count mismatch: ${name}`);
    distribution(samples.map((sample) => sample.ms));
    samples.forEach((sample, index) => {
      if (sample.iteration !== index) throw new Error(`Invalid sample order: ${name}`);
      if (
        !Array.isArray(sample.longTasks) ||
        sample.longTasks.some((ms) => !Number.isFinite(ms) || ms < 0)
      )
        throw new Error(`Invalid long-task evidence: ${name}`);
      if (sample.providerCalls !== (name === "message.feedback" ? 1 : 0))
        throw new Error(`Unexpected provider call count: ${name}`);
    });
  }
}

function validateBaseline(baseline: Baseline) {
  if (baseline.schemaVersion !== 1 || !baseline.acceptedBy?.trim() || !baseline.rationale?.trim())
    throw new Error("Baseline needs explicit reviewer and calibration rationale");
  validateRun(baseline.run);
  if (baseline.run.dirty) throw new Error("Accepted baseline must come from a clean revision");
  if (Object.keys(baseline.limits).sort().join() !== [...metricNames].sort().join())
    throw new Error("Missing or unexpected metric limits");
  for (const name of metricNames) {
    const limit = baseline.limits[name];
    if (
      Object.keys(limit).sort().join() !==
        ["relative", "noiseFloorMs", "medianBudgetMs", "p95BudgetMs"].sort().join() ||
      Object.values(limit).some((n) => !Number.isFinite(n) || n <= 0)
    )
      throw new Error(`Invalid calibrated limits: ${name}`);
  }
}

export function compare(baseline: Baseline | undefined, current: Run) {
  if (!baseline)
    throw new Error("Missing accepted baseline; use explicit collect mode (non-gating)");
  validateBaseline(baseline);
  validateRun(current);
  const reference = baseline.run;
  for (const key of ["fixtureVersion", "metricVersion", "harnessHash", "samplesPerMetric"] as const)
    if (reference[key] !== current[key])
      throw new Error(`Incompatible ${key}; collect and review calibration`);
  const environmentKeys = Object.keys(reference.environment).sort();
  if (environmentKeys.join() !== Object.keys(current.environment).sort().join())
    throw new Error("Incompatible environment fields");
  for (const key of environmentKeys as (keyof Environment)[])
    if (reference.environment[key] !== current.environment[key])
      throw new Error(
        `Incompatible environment.${key}: ${reference.environment[key]} != ${current.environment[key]}`,
      );
  const failures: string[] = [];
  const rows = metricNames.map((name) => {
    const before = distribution(reference.metrics[name].map((sample) => sample.ms));
    const after = distribution(current.metrics[name].map((sample) => sample.ms));
    const limit = baseline.limits[name];
    for (const stat of ["median", "p95"] as const) {
      const regressionLimit =
        before[stat] + Math.max(before[stat] * limit.relative, limit.noiseFloorMs);
      const budget = stat === "median" ? limit.medianBudgetMs : limit.p95BudgetMs;
      if (after[stat] > regressionLimit)
        failures.push(
          `${name} ${stat}: ${after[stat].toFixed(1)}ms > regression limit ${regressionLimit.toFixed(1)}ms (reference ${before[stat].toFixed(1)}ms)`,
        );
      if (after[stat] > budget)
        failures.push(
          `${name} ${stat}: ${after[stat].toFixed(1)}ms > absolute budget ${budget.toFixed(1)}ms`,
        );
    }
    return { metric: name, before, after };
  });
  return { passed: failures.length === 0, failures, rows };
}

/** Never called by collection/comparison. Destination creation must use exclusive write. */
export function prepareAcceptance(
  run: Run,
  limits: Baseline["limits"],
  acceptedBy: string,
  rationale: string,
): Baseline {
  const baseline: Baseline = { schemaVersion: 1, run, limits, acceptedBy, rationale };
  validateBaseline(baseline);
  const result = compare(baseline, run);
  if (!result.passed)
    throw new Error(`Calibration violates budgets: ${result.failures.join("; ")}`);
  return baseline;
}
