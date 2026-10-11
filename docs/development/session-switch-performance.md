# Session-switch performance measurement

Run the repository-owned comparison with an explicit baseline revision:

```sh
pnpm measure:session-switch <baseline-revision>
```

The [runner](../../scripts/measure-session-switching.mjs) exports the baseline to a
temporary directory and builds both applications. Matching lockfiles reuse installed
dependencies; otherwise it installs the baseline's locked dependencies offline from
pnpm's cache. The baseline therefore does not inherit current dependency patches.
It runs the [Electron scenario](../../tests/electron/session-switching.performance.spec.ts)
in ABBA order with isolated Cake data and removes temporary fixtures afterward.
It does not modify Git worktrees or the installed application.

The scenario uses generated session identities, navigation history and transcripts,
not the user's data. Its provider is an unused local endpoint; no prompt is submitted.
Read the scenario and generated summary for current workload sizes and sample counts.
Without the runner's baseline environment, it skips in ordinary Electron runs.

Both builds use identical CPU profiling. Motion is enabled by default; repeat with
`CAKE_PERFORMANCE_REDUCED_MOTION=1 pnpm measure:session-switch <baseline-revision>`
to compare without fades. Do not mix these two modes when attributing improvements.

## Metrics and output

- **Click dispatch:** Chromium's complete renderer `EventDispatch` duration, including synchronous work and rendering before dispatch finishes—not all later asynchronous work.
- **Transcript commit:** click to MutationObserver detection of destination content. DOM readiness, not compositor/pixel presentation.
- **Largest delayed task:** longest renderer `RunTask` after dispatch and before the next click's enclosing task; not necessarily persistence work.
- **Long-task total:** renderer tasks of at least 50 ms overlapping the observation window, excluding the next click's enclosing task.
- **Frame boundary:** a requestAnimationFrame after destination content enters the DOM, including hidden-window scheduling overhead.
- **Transcript visible:** first animation-frame opportunity with visible computed visibility, nonzero opacity and non-hidden display on the destination list and ancestors; excludes the outgoing clone.
- **Transcript settled:** first such visible opportunity without running animations on the list or ancestors. Neither visibility nor settling proves actual displayed pixels.

Results go under Git-ignored `.performance-captures/session-switching/`.
`summary.json` records revisions, scenario parameters, individual samples, median,
p95, maximum and normalized persisted payload sizes. CPU profiles remain in trace files.

Record comparisons and investigations in an artifact with the checked revisions,
workload, motion preference and measurement limitations. Generated hidden-window
measurements are not a replay of real user workloads or a cold-session latency guarantee.
