# User-visible performance regression checks

These checks complement Electron correctness tests. They launch the compiled slim
app with isolated, generated on-disk Pi history and a deterministic loopback model.
They never read the user's profile. Normal `test:electron` excludes `@performance`;
`playwright.performance.config.ts` runs it serially, without retries or native focus.
The older `measure:session-switch` ABBA investigation remains available separately.

## Commands

```sh
# Builds slim, then collects 60 samples per metric. Explicitly NON-GATING.
pnpm perf:collect --profile local-dev --output .performance-captures/local-run

# Small harness smoke test only; cannot become an accepted baseline.
pnpm perf:collect --profile local-dev --samples 3

# Builds and compares against an explicitly chosen, reviewed baseline. Missing,
# incompatible, incomplete or undersampled references/runs are errors, not skips.
pnpm perf:check --profile cake-performance-v1 \
  --baseline tests/fixtures/performance/baselines/cake-performance-v1.json
```

Output directories must be new. `run.json` retains raw timings, iteration order,
long tasks, provider request counts, median/p95 inputs, app revision and dirty-tree
status, collection time, fixture/metric versions, harness hash and environment.
`summary.json` contains count, median and nearest-rank p95. Comparisons additionally
write `comparison.json` with metric/stat-specific failures. Playwright retains its
trace on scenario failure; every run also retains a streaming gzip-compressed Chromium
renderer timeline (`renderer-trace.json.gz`) and partial samples under `evidence/`,
including when timing comparison fails afterward. `renderer.cpuprofile` retains
1 ms sampled CPU stacks. `diagnostics.json` records actual native RPC request
counts by tag, opt-in navigation entry/phase marks, and heap usage per sample.
These diagnostics include work between the pre/post driver snapshots, not exact
exclusive attribution to the metric. Repeated sampled stacks are never call counts.
Profiling overhead is fixed for both control and candidate. User-timing spans named
`cake.perf.<metric>.<iteration>` correlate trace events with raw samples. Decompress
the timeline to JSON before loading it in a trace viewer if needed.
A failed/incomplete scenario is never usable as a complete run. Trace overhead is
part of this fixed profile; don't compare to untraced measurements.

## Workload and markers (visible-readiness-v2)

[`tests/fixtures/performance/v2.json`](../../tests/fixtures/performance/v2.json)
and its deterministic generator define at least 828 sessions, each with 240 mixed
user/assistant messages (1,000 in each of the two warm destinations), substantial
prose and code, 9,998 navigation-history entries, restored renderer identities,
composer state and workspace-sidebar pane preferences. This retained-identity
workload is not comparable to the original 80-session v1 fixture. No user data or provider credentials are copied. Larger requested
sample counts expand the distinct session set; sample count must match exactly
for comparison. Use the fixed default for calibrated runs.

All starts are renderer capture-phase **native DOM events**, before application
handlers. End markers are checked in animation frames, then rechecked one frame
later, without Playwright polling/driver time inside the measured interval. End
content must have layout, visible computed styles, nonzero ancestor opacity and
no running ancestor animations. Outgoing inert transcript clones are excluded.
Actual focus, typing, retained draft and enabled submission are additionally
checked after every cold switch, resolve and restore (outside the timed interval);
warm switches have the separate timed composer-input check. The second frame
requires the renderer event loop to run again, but is not a bound on subsequent
input latency. This is a **hidden-window DOM/paint-opportunity readiness proxy**,
not proof of compositor presentation or real foreground pixel latency. Metric v2
requires the expected transcript marker after resolve and restore as well as after
switching; v1 restore checked only the composer. Do not compare across versions. Native windows stay
hidden and unfocused; no desktop activation is required.

| Metric              | Start                                            | End and setup                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switch.cold.ready` | sidebar destination row `mousedown`              | Destination transcript marker and enabled composer visible/settled. Each target has never been opened in this process. Restored identity/pane state exists, but no loaded transcript or Pi runtime. OS filesystem caches are **not** flushed; app startup and fixture generation are excluded. |
| `switch.warm.ready` | sidebar row `mousedown`                          | Same end marker. Five fixed discarded visits hydrate two destinations and ordinary JS/render paths. Samples alternate between just these two destinations without retention eviction.                                                                                                          |
| `composer.input`    | first character `keydown` after each warm switch | Controlled textarea retains the actual typed `x` at the next frame opportunity; focus and enabled Send are also asserted. Focus setup and draft clearing are outside timing.                                                                                                                   |
| `session.resolve`   | selected session's Resolve `mousedown`           | Resolved row visible in the already-expanded resolved lane, previous conversation and composer ready. Repeats resolve/restore of the same session, including real retirement/navigation/persistence. A spare resolved session keeps the lane open.                                             |
| `session.restore`   | resolved session's Restore `mousedown`           | Active sidebar action, destination transcript marker and composer visible, resolved notice/row gone. Opening its archived transcript is setup, excluded from restore timing.                                                                                                                   |
| `message.feedback`  | enabled Send `mousedown`                         | Submitted user text visible, draft cleared, Stop feedback visible/settled. Real typing precedes submission and is checked, but excluded from this interval. Three sends warm the runtime/HTTP path; subsequent sends accumulate in one transcript.                                             |

Send uses the real native RPC, Pi prompt path and provider HTTP serialization.
No utility model is configured: automatic naming/labeling is outside this workload;
sessions have saved titles. The local stub **holds every response/token** until feedback measurement completes,
then emits a fixed acknowledgement. Exactly one provider request per send is
asserted; external model HTTP is rejected. Model/provider/network response latency
cannot enter the feedback metric. Stub completion is setup for the next sample,
not a response-speed benchmark. No optimization of application behavior is part
of these checks.

Loops retain the same process, so switching, resolve/restore and sending exercise
repeated use rather than repeatedly resetting away accumulation. Raw chronological
samples and the timeline support early/late comparisons. Long-task durations are
supplementary evidence, not a separate timing gate. Request counts describe model
HTTP calls, **not** inferred duplicate `openSessionTarget`/IPC calls.

## Calibration and explicit acceptance

**No accepted baseline or product budgets ship yet.** A local developer desktop is
not a controlled runner. The dedicated runner label below is a provisioning contract,
not evidence that hardware has been provisioned. A passing collection is not proof
that current latency is acceptable.

Before enforcement, provision a single idle, AC-powered dedicated desktop with
label/profile `cake-performance-v1`; keep OS, CPU/core count, memory, Node, Electron,
Playwright, viewport, motion, hidden mode and trace settings fixed. Avoid concurrent
builds/tests and foreground work. The environment fingerprint and harness hash must
match exactly; changing dependencies/OS/harness requires reviewed recalibration,
not relaxed compatibility. The profile name is an operator assertion of equivalent
power/load/desktop conditions, not an automatic load detector.

1. On a clean committed revision, collect at least three independent full runs
   on that runner, across restarts. Inspect raw tails, long tasks and early/late
   behavior, and compare run-to-run drift. Increase samples (consistently for all
   runs) if p95 is unstable. At 60 samples nearest-rank p95 is rank 57: only three
   observations lie above it. This is a useful initial tail signal, not a confidence
   interval or a statistical significance claim. More repetitions cost runtime;
   repeating clean runs distinguishes noise from persistent slowdowns. Do not
   cherry-pick the fastest run or retry a failing timing job until it passes.
2. Write a reviewed limits JSON with **every metric name** mapped to
   `{ "relative": fraction, "noiseFloorMs": milliseconds, "medianBudgetMs": milliseconds, "p95BudgetMs": milliseconds }`.
   Choose relative thresholds and noise floors from observed run-to-run spread;
   choose absolute ceilings from those observations **and** user-visible acceptance
   criteria. No made-up passing values or automatic budget generation is provided.
3. Keep aspirational improvement targets separate from this measured reference
   and its enforcement ceilings. If today's behavior is unacceptable, say so;
   don't redefine the measured reference as a product target.
4. Create a new baseline candidate deliberately:

   ```sh
   pnpm perf:accept --run .performance-captures/calibrated/run.json \
     --limits /path/to/reviewed-limits.json \
     --baseline tests/fixtures/performance/baselines/cake-performance-v1.json \
     --reviewer REVIEWER --rationale 'Calibration observations and budget rationale'
   ```

   Acceptance requires a complete clean-revision run, at least 60 samples, explicit
   reviewer/rationale and valid budgets. The command refuses to overwrite any file.
   Commit/review the candidate and limits with their calibration evidence. To
   replace an accepted reference, create a **new named file** and explicitly update
   the CI reference in the same reviewed diff. Neither passing collection nor
   comparison ever writes an accepted baseline. Do not accept local smoke results.

For **both median and p95**, failure occurs if current exceeds either:

- reference + `max(reference × relative, noiseFloorMs)`; or
- its absolute budget.

The noise floor prevents tiny, meaningless relative failures; the independent
absolute budget prevents slow behavior being excused by a slow reference. Unit
fixtures contain synthetic numbers only; those are not Cake's calibrated budgets.

## CI

The `Performance` workflow runs an always-on hosted comparator-unit/CLI-test job
for PRs/main pushes. Desktop timing never runs on
arbitrary hosted machines or on untrusted PR code on self-hosted hardware.

Manual workflow dispatch explicitly selects `collect` (non-gating) or `check`
(strict). A dedicated `self-hosted, cake-performance-v1` runner is required.
Set repository variable `CAKE_PERFORMANCE_ENFORCE=true` **only after** reviewing
calibration and committing the referenced baseline. Main pushes then enforce the
strict timing check. Without that opt-in there is no automatic desktop timing
gate; the hosted arithmetic tests still run. With it, missing/incompatible baselines
fail clearly. CI retains raw samples and traces for 14 days, even on failure.
