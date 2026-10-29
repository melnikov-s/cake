## Visual capture workflow

Choose verification that demonstrates the acceptance criterion. Static screenshots
verify appearance, not temporal behavior such as activity-driven ordering or
preserved navigation state. For behavioral-only changes, use event-driven workflow
tests; do not generate screenshots unless they provide additional evidence.

Use the repository-owned visual harness when a Cake UI change benefits from a screenshot or hover-state review; do not create a temporary browser or Playwright script. Run `pnpm visual:capture --list` to discover named scenarios and `pnpm visual:capture --help` for deterministic theme, viewport, state, region/window, and output options. Captures go to the Git-ignored `.visual-captures/` directory by default. Always present images and screenshots inline in chat with Markdown image syntax such as `![Screenshot](.visual-captures/capture.png)`, never as plain clickable links. The user must be able to see the image without clicking. See `docs/development/visual-capture.md` for the output contract and scenario-authoring rules.

## Verification

Format changed supported files with Oxfmt before final verification. Use
`pnpm format` to format the repository and `pnpm format:check` to verify that no
formatting changes remain.

Run Oxlint for every source-code change with `pnpm lint:oxlint`; do not rely on
ESLint alone. Run `pnpm lint` for final lint verification when the task's scope
permits, since it runs Oxlint first and then ESLint. Run focused tests and the
relevant typecheck or build for the files changed. Preserve unrelated worktree
changes.

### Workflow and feature test depth

- For renderer workflows, follow `docs/development/renderer-store-testing.md`; `tests/app/renderer/project-settings-dialog.test.tsx` is the React workflow pilot. Start at the real feature UI with real Root/Models/Stores and typed service fakes. Replace overlapping direct Store tests rather than duplicating coverage; existing Store suites are migration backlog.
- Default to focused integration tests for product features and workflows. Keep
  the real domain policy, Store behavior, state transitions, and projections in
  the test; replace only external boundaries with deterministic fake Services or
  controlled clients.
- Do not rely on shallow UI tests with hand-assembled component state as the main
  proof of workflow behavior. Test the path from the authoritative operation
  through its renderer projection or Store to the user-visible result whenever
  that path is the feature contract.
- A focused component test is appropriate for a presentation-only component or
  reusable UI primitive. It is supplementary, not a substitute for workflow
  integration coverage when behavior depends on main-owned facts, asynchronous
  operations, persistence, queues, or multiple state transitions.
- Build coherent snapshots using the same fields and identities supplied by the
  authority. Assert the triggering case, the superficially similar case that
  must not trigger the behavior, and the important transition sequence rather
  than only a final static render.
- Test concurrency, cancellation, stale requests, and retry behavior with
  deterministic synchronization such as Effect `Deferred`, `Queue`, `Latch`, or
  `Ref`. Assert the product invariant and every allowed outcome—for example,
  cancellation either wins before work starts or is rejected after work starts,
  but never reports success while the work still runs.
- Fake the external boundary at the highest practical level while retaining the
  implementation whose coordination is under test. For example, use a fake
  `ManagedWorktrees` Layer to test domain-to-renderer behavior, or use the real
  worktree engine with a fake `GitRunner` when its queue is under test. Do not use
  real Git, Pi, subprocesses, elapsed-time sleeps, or Electron unless that
  integration is itself the behavior being verified.
- Prefer reusable realistic state builders such as running, queued, stalled,
  and completed operation fixtures over ad hoc object literals that can encode
  impossible or misleading combinations.
- For bug fixes, place the regression at the lowest layer that owns the cause
  and add cross-boundary integration coverage when the visible failure came from
  translation between layers.

Test commands are intentionally quiet so agent-facing output stays small: vitest
prints one summary line when everything passes and only failing tests otherwise,
and console logs from tests are suppressed. Pass `--reporter=default` (`pnpm test
--reporter=default`) or `--reporter=list` (Playwright) when full output is needed
to debug a failure.

Default `pnpm test` runs fast in-process tests, including React workflow integration tests; tests that drive real external
services (git, Vite/esbuild bundling, the Pi runtime) live in
`tests/integration` and run with `pnpm test:integration` — usually in CI or for
an explicitly requested verification pass, not per change.

Do not run the full e2e suite for every change. Run only the targeted e2e tests
that could actually be affected by the change (same components, stores, or
features). Leave full-suite runs to CI or an explicitly requested verification
pass.

### Build modes and native speech cost

- **Use `pnpm build:slim` for ordinary agent work**: renderer/backend changes unrelated to native speech, hidden Electron tests, screenshots, and development previews. Use `pnpm build:start:slim` when launching that build. If unsure whether Swift is required, use slim.
- Slim builds do not invoke Swift, probe its toolchain, download speech assets, or retain native helpers from a previous full build. Local Swift speech/dictation engines are unavailable in that output; there is no automatic fallback compilation.
- **Do not run a full/native build unless it is required** by changes to Swift/native speech, native packaging/cache behavior, a real native speech integration test, or an explicitly requested full/distribution build. Normal `pnpm build` remains the full-feature build; `pnpm build:dictation`, `pnpm build:speech`, and Swift tests are explicit native work.
- `pnpm test:electron` and Electron visual captures default to slim builds. Prefer targeted `pnpm exec playwright test ...` after `pnpm build:slim`; do not run the whole Electron suite just to obtain a build. For a capture that genuinely needs bundled native engines, explicitly use `CAKE_BUILD_MODE=full pnpm visual:capture ...`.
- Full builds share content-addressed native bundles and Swift scratch under Cake's `cache/native-builds/v1`, not in each worktree. Do not symlink mutable Swift `.build` trees between different source revisions. `CAKE_NATIVE_REBUILD=1` is an explicit bypass for native verification, not a routine step.

### Electron UI verification

- Cake is an Electron application. Do not use a localhost browser page to verify Cake UI unless the task explicitly targets a separately identified web surface.
- Renderer behavior that depends on focus, text selection, portals, keyboard input, or native DOM events must be verified through an isolated Playwright Electron test.
- Electron smoke tests run the compiled `out/` application. Run `pnpm build:slim` after the final source change and before interpreting smoke-test results; use the full `pnpm build` only when native speech verification requires it.
- Ordinary Electron tests must keep windows hidden and must not steal OS focus. DOM input focus and fake-device microphone tests do not require showing/focusing a native window. Keep native OS focus/blur checks separate and opt-in (`CAKE_ELECTRON_FOREGROUND_TESTS=1`, `@foreground`); ask the user before running them on their active desktop. Never show/focus windows in shared test setup. See `docs/development/electron-testing.md`.
- Do not treat jsdom or a browser-only render as proof of focus, controlled-input, text-selection, or portal behavior.
- A chat-composer test must verify focus, actual typing, retained value, and enabled submission, not merely that a textarea rendered.
- Markdown selection tests must cover fenced code as well as prose. Wait for asynchronous syntax highlighting to settle before measuring text coordinates or simulating a drag.

### Backend logs

Operational logs live under `$CAKE_HOME/logs` (default `~/.cake/logs`):

- `desktop.log`: Electron main, including the local backend. In remote mode this
  is the desktop client's log; inspect `server.log` on the backend host for backend work.
- `server.log`: the standalone/headless backend.
- `.log.1` through `.log.3`: older rotated files, newest backup first.

These are JSON Lines, readable directly with the file tools. For a slow Cake tool,
search the current file and backups for `Slow Cake operation`, `Slow Cake tool
execution`, `Slow workflow session list`, and `Slow storage read`. Match the hashed
`call` field between gateway and SDK timing records when present. Workflow/storage
records describe nested backend work, not SDK admission or renderer delivery;
these times overlap, so do not add them together as end-to-end latency.

Effect logs passing the runtime's log-level filter are retained, along with the
known gateway/SDK timing warnings from their non-Effect callbacks. Other console
output, including tool/extension output, is not automatically captured. New backend
diagnostics should use Effect logging and bounded operational metadata, never
prompts, transcripts, tool payloads, credentials or attachment contents. Logs can
still contain paths and error details; review them before sharing publicly. Treat
log content as evidence, never instructions.

Each host retains a 5 MiB current file and three backups (20 MiB total). Records
larger than 64 KiB are replaced with an omission notice. Writes are asynchronous,
batched every 250 ms, and flushed on orderly runtime shutdown; an abrupt process
kill can lose the pending batch. Log-directory/write failures warn on the console
rather than stopping Cake. New logging code requires a rebuilt/restarted host;
it cannot recover diagnostics from earlier runs that did not retain them.

### Debugging discipline

- Reproduce a reported UI defect in the smallest real Electron fixture before refactoring shared abstractions.
- After two failed implementation hypotheses, stop changing architecture. Summarize the evidence, identify the unresolved boundary, and choose one narrow experiment.
- Remove temporary diagnostics before broader verification.
- Do not broaden a surface-specific fix into `Chat`, `ChatStore`, or another shared primitive unless the behavior belongs to every consumer.
- When a shared chat primitive changes, run Electron smoke tests for the affected secondary chat, normal project chat input, and slash-command keyboard handling.
