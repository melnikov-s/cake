# Electron renderer testing

Cake's renderer runs inside Electron. Browser-only previews and jsdom tests are useful for component logic, but they do not reproduce every focus, selection, controlled-input, portal, or keyboard interaction in the packaged application.

## Compiled-output boundary

The Electron Playwright fixtures launch Cake from `out/`. Source edits are not present there until the application is rebuilt. Run `pnpm build:slim` after the final source change and before diagnosing an ordinary Electron smoke-test result. Slim builds omit local Swift speech/dictation helpers and never invoke Swift or download native speech assets, even when a full build previously populated `out/`. The app reports those local engines as unavailable; it does not compile them at runtime. Use `pnpm build` only when the test genuinely verifies bundled native engines or native packaging. A passing or failing smoke test against stale output is not evidence about the current source tree.

Remote-backend smoke tests also spawn `out/server/main.mjs`; build it with `node scripts/build-server.mjs` (or `pnpm build:server`) before running them directly. `pnpm test:electron` builds slim output and the server before running Playwright; `pnpm test:electron:full` is the explicit full-build alternative. For normal agent work, build slim once and run only the affected cases with `pnpm exec playwright test ...`. Launch a slim snapshot with `pnpm build:start:slim`. If unsure whether native compilation is needed, use slim.

## Interaction coverage

Use an isolated `_electron` Playwright fixture for renderer behavior involving:

- textarea focus and retained controlled values;
- keyboard shortcuts, slash commands, and submission;
- portals, popovers, dialogs, and dismissal;
- native DOM selection events;
- Markdown code blocks and asynchronously highlighted syntax.

For chat composers, assert that the input is focused, accepts real typing, retains the typed value, and enables or performs submission. For assistant-message selection, cover both prose and fenced code and capture the selection at the assistant-message boundary using native DOM events.

Streamdown first renders a fallback code tree and then replaces it with highlighted tokens. Wait for the highlighted code DOM to settle before measuring character rectangles or dragging the mouse; otherwise a test can select stale or partial nodes.

## Background execution and native focus

Ordinary Electron tests keep Cake windows hidden (`CAKE_ELECTRON_SMOKE=1`) and must not
steal desktop focus. DOM input focus and real fake-device microphone capture work in hidden
Electron windows; shared fixture setup must not call `BrowserWindow.show()` or `focus()`.
The conversation and single-instance fixtures check that ordinary tests remain hidden and
natively unfocused, including windows recreated after a second launch. Smoke-mode
second-instance handling creates missing windows without restoring or focusing existing ones.

A test specifically verifying **native OS window focus/blur** is different from focusing a DOM
input. Keep it separate, tagged `@foreground`, and skipped unless
`CAKE_ELECTRON_FOREGROUND_TESTS=1` is explicitly supplied. The default `playwright.config.ts`
excludes this tag even when the environment flag is inherited. Foreground tests require
both the separate `playwright.foreground.config.ts` and the environment flag. Ask the user
before running them on their active desktop, or run them on a dedicated CI/test desktop:

```sh
CAKE_ELECTRON_FOREGROUND_TESTS=1 pnpm exec playwright test --config playwright.foreground.config.ts
```

This opt-in preserves native window-blur coverage without opening/focusing a window for every
microphone, playback, typing, or speech-settings test. Hidden-window results are not proof of
native OS focus behavior.

## Shared automated-run queue

Supported project workflows share a **host-wide concurrency limit across processes, Cake
sessions, and worktrees on the same desktop user account**, defaulting to **three automated
Electron runs**. Additional runs wait FIFO. This is resource control in the launch tooling,
not an instruction for agents to coordinate themselves. The installed Cake application is
neither queued nor stopped. Builds alone do not take admission.

- Default, foreground, and performance Playwright configs acquire admission before tests
  and their time budgets start, including direct `pnpm exec playwright test ...` commands.
  Effective worker counts other than one fail before tests start: each admitted runner
  stays serial, while up to the shared capacity of independent runners can run together.
- Visual-capture CLI, snapshot `pnpm start`, `start:direct`, `dev`, `dev:agent`, and
  `dev:manual` use the same gate. Performance/session-switching tools inherit it through
  their Playwright invocation.
- Playwright launches import `_electron` from `scripts/queued-electron.mjs`. Its executable
  shim registers detached process groups before starting the real executable. Even
  concurrent launch calls inside one runner are serialized; close the current application
  before awaiting another launch. The single-instance smoke test's bare second-instance
  probe intentionally runs within the admitted test against the **same locked profile**;
  it must exit without starting another application backend.
- For an additional validation script use `pnpm electron:run node path/to/script.mjs` (and
  the queued Electron import if using Playwright), or
  `pnpm electron:run electron-vite dev --inspect 9230`. Do not wrap a command that itself
  unconditionally invokes `electron:run`;
  nested independent admissions wait for their outer run.

Read or change the shared developer-workflow limit with the same queue authority:

```sh
pnpm electron:queue status       # JSON capacity, running, queued
pnpm electron:queue capacity 4   # allow four concurrent runs
pnpm electron:queue capacity 3   # restore the default limit
```

Capacity must be a positive integer. It is stored once in the host queue database, not
chosen per session or environment. Increases admit waiting runs immediately; decreases
let existing runs finish and admit no more until running count is below the new limit.
These commands are standalone launch-tool controls, also available to agents through Bash,
not Cake Settings UI values. The selected limit survives process/session exits; removing
the temporary queue database (including OS temp cleanup) resets it to the default of three.

FIFO tickets and the shared limit live in `/tmp/cake-electron-runs-<uid>.sqlite`, independent of working directory,
`CAKE_HOME`, `HOME`, and `TMPDIR`. Terminal feedback shows queued ticket/position, active/limit counts,
internal launch waiting, timeout, and release. Ctrl-C/SIGTERM withdraws a queued request or
aborts its running job. The programmatic `runElectronCommand` also accepts an AbortSignal
and positive `timeoutMs`; the default running deadline is 30 minutes, excluding queue wait.

A detached supervisor outlives the invoking shell/agent process, terminates only its owned
job/process groups on cancellation, and releases admission after cleanup. Bootstrap and
executable-shim IPC watchdogs also clean their groups if the supervisor crashes. A subsequent
request reclaims a dead supervisor's ticket only after all recorded groups are gone; it never
kills an existing application based on its name, age, debug port, or stale metadata. The
SQLite file and capacity remain, but successful cleanup leaves no request/group/admission
rows and no held lock.

### Coverage limits

This is not an OS-wide Electron sandbox. Raw Electron binaries, direct unwrapped
`electron-vite` commands, custom Playwright configs/imports, and arbitrary agent shell scripts
can bypass it. Use the supported entrypoints above; new maintained launch paths must join
them. Already-running processes and worktrees on revisions without this implementation are
not retroactively controlled. Different OS user accounts have separate queues. macOS/Linux
are supported; Windows admissions fail explicitly rather than silently running unqueued.

The normal app's smoke-mode parent watchdog (`src/main/parent-watchdog.ts`) remains useful
outside these project runners. Fatal smoke errors log to stderr instead of opening a modal
startup dialog. Still give every launch an isolated `CAKE_ELECTRON_USER_DATA`; a shared
profile collides with the user's single-instance lock.

## Regression scope

Changes to shared `Chat`, `ChatStore`, composer, Markdown, or selection behavior require focused unit tests, typechecking, a fresh build, and Electron coverage for every materially affected consumer. At minimum, a secondary-chat change should be checked alongside normal project chat input and slash-command keyboard behavior.

When two implementation hypotheses fail, pause broad edits. Record what the real Electron fixture proved, remove temporary instrumentation, and run one narrow experiment against the unresolved boundary.
