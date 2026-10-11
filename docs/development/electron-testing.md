# Electron renderer testing

Cake's renderer runs inside Electron. Browser-only previews and jsdom tests are useful for component logic, but they do not reproduce every focus, selection, controlled-input, portal, or keyboard interaction in the packaged application.

## Compiled-output boundary

The Electron Playwright fixtures launch Cake from `out/`. Source edits are not present there until the application is rebuilt. Run `pnpm build:slim` after the final source change and before diagnosing an ordinary Electron smoke-test result. Slim builds omit local Swift speech/dictation helpers and never invoke Swift or download native speech assets, even when a full build previously populated `out/`. The app reports those local engines as unavailable; it does not compile them at runtime. Use `pnpm build` only when the test genuinely verifies bundled native engines or native packaging. A passing or failing smoke test against stale output is not evidence about the current source tree.

`pnpm test:electron` builds slim output before running Playwright; `pnpm test:electron:full` is the explicit full-build alternative. For normal agent work, build slim once and run only the affected cases with `pnpm exec playwright test ...`. Launch a slim snapshot with `pnpm build:start:slim`. If unsure whether native compilation is needed, use slim.

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

## Regression scope

Changes to shared `Chat`, `ChatStore`, composer, Markdown, or selection behavior require focused unit tests, typechecking, a fresh build, and Electron coverage for every materially affected consumer. At minimum, a secondary-chat change should be checked alongside normal project chat input and slash-command keyboard behavior.

When two implementation hypotheses fail, pause broad edits. Record what the real Electron fixture proved, remove temporary instrumentation, and run one narrow experiment against the unresolved boundary.
