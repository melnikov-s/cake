# Electron renderer testing

Cake's renderer runs inside Electron. Browser-only previews and jsdom tests are useful for component logic, but they do not reproduce every focus, selection, controlled-input, portal, or keyboard interaction in the packaged application.

## Compiled-output boundary

The Electron Playwright fixtures launch Cake from `out/`. Source edits are not present there until the application is rebuilt. Run `pnpm build` after the final source change and before diagnosing an Electron smoke-test result. A passing or failing smoke test against stale output is not evidence about the current source tree.

## Interaction coverage

Use an isolated `_electron` Playwright fixture for renderer behavior involving:

- textarea focus and retained controlled values;
- keyboard shortcuts, slash commands, and submission;
- portals, popovers, dialogs, and dismissal;
- native DOM selection events;
- Markdown code blocks and asynchronously highlighted syntax.

For chat composers, assert that the input is focused, accepts real typing, retains the typed value, and enables or performs submission. For assistant-message selection, cover both prose and fenced code and capture the selection at the assistant-message boundary using native DOM events.

Streamdown first renders a fallback code tree and then replaces it with highlighted tokens. Wait for the highlighted code DOM to settle before measuring character rectangles or dragging the mouse; otherwise a test can select stale or partial nodes.

## Regression scope

Changes to shared `Chat`, `ChatStore`, composer, Markdown, or selection behavior require focused unit tests, typechecking, a fresh build, and Electron coverage for every materially affected consumer. At minimum, a secondary-chat change should be checked alongside normal project chat input and slash-command keyboard behavior.

When two implementation hypotheses fail, pause broad edits. Record what the real Electron fixture proved, remove temporary instrumentation, and run one narrow experiment against the unresolved boundary.
