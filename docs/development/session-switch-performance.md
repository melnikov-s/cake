# Session-switch performance measurement

Run the repeatable comparison from the repository root:

```sh
pnpm measure:session-switch e9947a7d
```

The runner exports the baseline revision to a temporary directory and builds both applications. With matching lockfiles it reuses installed dependencies; otherwise it installs the baseline's exact locked dependencies offline from pnpm's cache. This keeps a current dependency patch from leaking into an unpatched baseline. It launches the repository-owned Playwright Electron scenario against each build in ABBA order. Neither build uses the user's Cake home or window data; generated fixtures and the exported baseline are removed afterward. No Git worktree or installed application is modified.

The scenario contains 429 loaded Project Session identities, 7,500 navigation-history entries, persisted nested session Store snapshots, and 250 authenticated fixture models in addition to Pi's built-in catalog. Two destination transcripts are hydrated before measurement. Their model provider points at an unused local port; the test never submits a prompt. Each run measures 12 alternating warm switches, producing 24 samples per build. A 600 ms observation interval after every switch includes the persistence debounce and delayed renderer work.

Both builds have identical CPU profiling enabled. Motion is enabled by default so transcript fades are included. Run `CAKE_PERFORMANCE_REDUCED_MOTION=1 pnpm measure:session-switch <revision>` to repeat with fades disabled. Timings are recorded observations, not brittle CI performance assertions. Without the runner's baseline environment, the scenario skips in ordinary Electron runs.

## Metrics and output

- **Click dispatch:** Chromium's complete renderer `EventDispatch` duration for each click. This includes synchronous application work and rendering processed before dispatch finishes, not all subsequent asynchronous work.
- **Transcript commit:** elapsed renderer time from the captured click to a MutationObserver seeing the destination transcript in the DOM. This is DOM readiness, not compositor/pixel presentation.
- **Largest delayed task:** the longest renderer `RunTask` following click dispatch and before the next click's enclosing task. It includes persistence-related work but is not a persistence-only attribution.
- **Long-task total:** renderer tasks of at least 50 ms overlapping the switch observation window, excluding the next click's enclosing task.
- **Frame boundary:** a following requestAnimationFrame after the destination transcript enters the DOM, even if hidden. Smoke windows are hidden; this metric includes fixture scheduling overhead and must not be described as actual display latency.
- **Transcript visible:** the first requestAnimationFrame opportunity where the destination Conversation list and its ancestors have visible computed visibility, nonzero opacity, and non-hidden display. This excludes the disposable outgoing transcript clone.
- **Transcript settled:** the first such visible opportunity without running animations on the list or its ancestors. Neither this nor the visible metric proves compositor/pixel presentation.

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

## Flicker-fix visibility investigation

The two relevant commits are:

- `ad1678b6`: normal bottom opening now supplies `initialTopMostItemIndex={{ index: "LAST", align: "end" }}`. Previously it rendered without an initial index and aligned the bottom afterward. The new path prevents painting the wrong position by letting Virtuoso hide the list while initializing.
- `e21cc931`: adds an inert DOM clone for a 100 ms outgoing fade and a 160 ms incoming fade. Loading and destination mounting continue independently, but reveal waits for the outgoing animation and hydrated destination.

The installed React Virtuoso 4.18.11 implementation explains the hidden interval: nontrivial initial locations wait four requestAnimationFrame callbacks before scrolling, and `scrollToIndex` waits 150 ms without a size change before reporting success. Size changes can retry this operation. The list remains `visibility: hidden` until that initial operation succeeds. Every keyed transcript remount repeats this initialization, including already-hydrated sessions. The fade and library waits overlap; their durations must not simply be summed.

An isolated Electron ABBA comparison of `fdf1a3c2` (immediately before the first fix) and `a53994d4` recorded 24 warm switches per build with motion enabled:

| Metric (median)                | Before fixes |   Current |
| ------------------------------ | -----------: | --------: |
| Click dispatch                 |     54.60 ms |  34.61 ms |
| Destination transcript DOM     |     57.65 ms |  36.70 ms |
| Destination transcript visible |     66.65 ms | 263.30 ms |
| Destination transcript settled |     66.65 ms | 312.15 ms |

A second comparison with reduced motion recorded current DOM arrival at 34.85 ms and visibility/settling at 261.60 ms. Disabling fades therefore does not remove the main hidden interval. These were separately run samples, not paired per-switch measurements; machine variability makes small differences unsuitable for attribution. The benchmark destinations each contain one user message, demonstrating that this delay does not require a large transcript. The separate `reopens a large loaded session` Electron smoke test still passes its frame-by-frame bottom-position assertions with 480 messages.

The primary improvement to investigate is replacing the fixed initial-scroll settling gate with readiness based on the actual destination layout, without exposing an incorrectly positioned frame or reintroducing uncancellable bottom retries. Merely shortening/removing fades will not address most of the measured delay. Cached measurements may reduce remount work, but `restoreStateFrom` alone is not a proven fix: the installed implementation converts its scroll offset back into the same initial-index path. Keep large bottom-opening, saved-history anchors, and upward-input cancellation regressions when experimenting.

Historical DOM-only performance numbers above were collected with reduced motion and cannot establish the user-visible latency of these fixes. Current reports record the motion preference and separate DOM arrival, computed visibility, and animation settling.

### Frame-based initial readiness

`patches/react-virtuoso@4.18.11.patch` changes only the initial-positioning path, in both the ESM and CommonJS bundles. The dependency is pinned to that version:

- Begin positioning after two frames instead of four.
- Mark the private initial scroll request so ordinary `scrollToIndex` behavior retains its existing 150 ms retry window.
- Wait for three quiet animation frames after an initial scroll instead of 150 ms. ResizeObserver measurements are deferred to the following frame by Virtuoso; three frames allow those measurements to invalidate positioning and retry before revealing the list.
- Preserve Virtuoso's hidden-until-positioned list, measurement retries, and final readiness signal. No renderer Store, transcript cache, retained Chat, or new persistence is introduced; readiness remains ephemeral, mount-owned DOM measurement state.

`ContentTransition` now uses a 40 ms exit and an 80 ms opacity-only entrance. The destination still mounts immediately, and reduced motion still bypasses fades.

An ABBA comparison against the unchanged, compiled `a53994d4` application with its original unpatched dependencies recorded 24 warm switches per variant:

| Metric (median)                | Before optimization | Optimized |
| ------------------------------ | ------------------: | --------: |
| Destination transcript DOM     |            32.35 ms |  31.70 ms |
| Destination transcript visible |           260.85 ms | 130.40 ms |
| Destination transcript settled |           297.25 ms | 147.45 ms |

Visibility and settling improve by approximately 50%, without changing DOM arrival materially. These remain generated short-transcript, hidden-window observations, not exact real-world pixel latency. The existing 480-message frame-by-frame bottom-opening, saved reading-position, nested scrolling, and background-streaming Electron scenarios pass. The scroll smoke fixture now explicitly excludes outgoing transition clones when selecting the live transcript, avoiding transient strict-locator failures during fast top-position restoration. The native scrollbar-drag portion of `escapes bottom following during height measurement` fails on both this patch and the unchanged compiled baseline; its preceding wheel and keyboard cancellation checks pass. The slash-command smoke test also fails at its `/tree` panel assertion on both builds; preceding composer focus, typing, and keyboard completion checks pass. Draft-session input, staged-session input retention, and side-chat streaming smoke tests pass.

## Cold family-child reconciliation

`Trace-20261002T175207.json` was parsed programmatically (204,397 events, approximately 55 MB). Its renderer contained a 650.61 ms input task with 649.86 ms click dispatch, followed by a 785.69 ms task applying a Conversation update. Sampled stacks attributed approximately 295 ms and 306 ms respectively to `SessionRegistryStore.sessions`, and approximately 228 ms and 231 ms to Conversation lookup. These are sampled inclusive times and overlap; they must not be summed. The initial 1,019 ms renderer task was CPU-profiler startup, not session switching.

The captured bundle still used linear Project Conversation lookup. The current checkout already indexes that lookup and isolates loaded-identity reconciliation. However, Discussion, Subagent, and Scheduled Message catalog lookup still scanned an entire collection for each loaded Store. Opening an additional family child invalidates the keyed Store collection, so those three scans made even the current cold path quadratic in the number of loaded identities. These lookups now use the existing typed, reactive Model ID index instead of a separate cache.

A focused Node measurement used the real `RootProjection`, mounted `SessionRegistryStore`, and operation coordinator with 429 restored identities. After realization, it timed `loadUnlistedFamilySession` for one additional child across five fresh fixtures per implementation:

| Catalog lookup | Median child-load time |
| -------------- | ---------------------: |
| Linear scans   |              520.78 ms |
| Model ID index |               30.75 ms |

This is approximately **17× faster (94% less synchronous work)** for the Store operation—not an Electron click-to-paint measurement or a replay of the original trace. Regression tests cover indexed lookup, removal, recreation, identifier changes, snapshot application, and child loading without catalog scans. The Electron scenario `opens a new family child among hundreds of restored session identities` verifies parent and child transcripts and pane selection with the same 429-identity scale, without brittle timing thresholds.
