# Session-switch performance measurement

Run the repeatable comparison from the repository root:

```sh
pnpm measure:session-switch e9947a7d
```

The runner exports the baseline revision to a temporary directory, reuses the installed dependencies without installing packages, and builds both applications. It launches the repository-owned Playwright Electron scenario against each build in ABBA order. Neither build uses the user's Cake home or window data; generated fixtures and the exported baseline are removed afterward. No Git worktree or installed application is modified.

The scenario contains 429 loaded Project Session identities, 7,500 navigation-history entries, persisted nested session Store snapshots, and 250 authenticated fixture models in addition to Pi's built-in catalog. Two destination transcripts are hydrated before measurement. Their model provider points at an unused local port; the test never submits a prompt. Each run measures 12 alternating warm switches, producing 24 samples per build. A 600 ms observation interval after every switch includes the persistence debounce and delayed renderer work.

Both builds have identical CPU profiling enabled. Timings are recorded observations, not brittle CI performance assertions. Without the runner's baseline environment, the scenario skips in ordinary Electron runs.

## Metrics and output

- **Click dispatch:** Chromium's complete renderer `EventDispatch` duration for each click. This includes synchronous application work and rendering processed before dispatch finishes, not all subsequent asynchronous work.
- **Transcript commit:** elapsed renderer time from the captured click to a MutationObserver seeing the destination transcript in the DOM. This is DOM readiness, not compositor/pixel presentation.
- **Largest delayed task:** the longest renderer `RunTask` following click dispatch and before the next click's enclosing task. It includes persistence-related work but is not a persistence-only attribution.
- **Long-task total:** renderer tasks of at least 50 ms overlapping the switch observation window, excluding the next click's enclosing task.
- **Frame boundary:** a following requestAnimationFrame after the destination transcript appears. Smoke windows are hidden; this metric includes fixture scheduling overhead and must not be described as actual display latency.

The summary and raw Chromium traces are written under `.performance-captures/session-switching/` (Git-ignored, separate from ordinary Playwright cleanup). `summary.json` includes revision IDs, scenario parameters, individual samples, median, p95, maximum, and normalized persisted payload sizes. CPU profiles stay in trace files rather than being printed into agent context.

## Recorded comparison

Baseline: `e9947a7d12b52bad765c0e28a6ef7ed1ead1a6d4`.
Patched production: `d44232cd7bac88714c37d4fab78cc03fffc3ea2c`.
Each generated application's normalized persisted payload was 1,204,270 bytes, versus approximately 1,209,000 bytes in the aggregate characterization of the original workload.

| Metric                        | Baseline median | Patched median | Baseline p95 | Patched p95 |
| ----------------------------- | --------------: | -------------: | -----------: | ----------: |
| Click dispatch                |       204.89 ms |       27.85 ms |    223.41 ms |    34.76 ms |
| Transcript DOM commit         |       206.40 ms |       31.85 ms |    225.10 ms |    36.10 ms |
| Largest delayed renderer task |        34.52 ms |       24.01 ms |     40.02 ms |    30.18 ms |
| Long-task total               |       205.63 ms |           0 ms |    224.34 ms |        0 ms |

Median click dispatch improved by approximately **7.4× (86% less blocking)**. None of the 24 patched switches contained a renderer task of at least 50 ms in the captured observation windows; this is an observation, not a guarantee that every future switch avoids a long task.

These results compare equivalent generated workloads on the same machine. They are not a replay of the user's transcripts, a cold-session benchmark, or an exact reproduction of the original 305–328 ms dispatches. A new trace in the user's normal workload remains the real-world confirmation.
