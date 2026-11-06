# Cake advisory lint rules

`eslint.config.js` keeps existing error-level architecture checks intact. All
`cake/*` rules, source `max-lines`, `no-floating-promises`, and
`no-misused-promises` are **warnings**. Do not add `--max-warnings`, warning
thresholds, or a violation baseline. Existing violations are review prompts, not
instructions to refactor a file or evidence that a feature is broken.

Run `pnpm lint:eslint`; rule/config tests are in
`tests/app/config/cake-lint-rules.test.ts`. Source TypeScript uses the installed
parser's project service. Tests have no file-size cap. Handwritten source is
limited to 1000 nonblank, non-comment-only lines; assets, vendor, generated,
build and declaration files are excluded, not schema modules.

## Detection contracts

- **view-capability-boundaries** runs in feature components/hooks, not renderer
  bootstrap, infrastructure or UI primitives. It shares architecture import-path
  normalization and resolves imported TypeScript symbols through re-exports.
  Runtime Client/RPC/observer imports and calls on infrastructure-owned types
  warn. Type-only imports are allowed; a narrow presentation port such as
  `Pick<Client['filesystem'], 'readImage'>` remains legitimate. Broad capabilities
  passed through props are checked by receiver type. Unknown factories, opaque
  structural aliases and arbitrary dynamic module names are not inferred.
- **react-effect-ownership** resolves imported/aliased/namespace React hooks and
  actual `useState` setter bindings. During immediate setup it checks calls on
  actual r-state-tree Store subclasses returning a Promise, and direct setter
  copies of values also listed as dependencies. It does not diagnose all method
  calls, local state, or effects. DOM measurement calls, updater functions, sync
  retain/release and cleanup are valid. It deliberately does not follow unknown
  helpers, IIFEs, callback registrations, Promise continuations, or callbacks
  passed as identifiers. Async helpers and computed state copies need semantic
  review, not guesses based on a variable named `store`.
- **reactive-collection-contract** is standalone and has no Cake path knowledge.
  It checks direct same-class Store/Model fields initialized with imported
  `observable`/`toObservableTree`, or known plain literal/Map/Set containers.
  Plain-copy replacement of observable fields warns; direct plain-container
  mutators/property writes warn. Private plain fields need a same-class getter
  read, rather than assuming that every queue/buffer needs structural tracking.
  Plain-field reassignment, outbound copies, constructor initialization,
  rewrapping, unknown factories and unknown subsequent assignments are allowed.
  `@child` containers are managed by r-state-tree, including reassignment; they
  are not raw arrays. Inheritance, alias mutation, nested shallow values,
  `Object.assign` and helper-return provenance are not inferred. A getter read
  is a review signal, not proof of a user-visible stale view.
- **domain-native-orchestration** checks exported async functions/arrows
  (including later named exports) and unshadowed global domain timers. Nested
  Promise callbacks needed by SDK adapters and renderer Store async functions
  are not prohibited. Object methods named `setTimeout` are not global timers.
- **authoritative-controls** checks raw `button`, `input`, `select`, `textarea`
  JSX outside `components/ui`. Custom components and primitive internals remain
  allowed.
- **cause-recovery-boundaries** resolves Effect imports, including aliases and
  the `effect/Effect` subpath. Cause/defect recovery requires review outside the
  configured process/window supervisors. `catchTag` and cause observation are
  allowed. A best-effort recovery warning is not a critical-bug classification.
- **named-effect-operations** checks exported wrappers directly returning
  imported `Effect.gen`. Local/branch composition, Layer acquisition values,
  generic adapters and internal `fnUntraced` remain valid. It does not inspect
  arbitrary return paths or infer an operation from every generator.
- **deterministic-test-waits** checks Promise-as-sleep shapes that pass the
  resolver directly to `setTimeout` (or invoke only the resolver in its timer
  callback), and `waitForTimeout` on a known Playwright Page type or standard
  Playwright fixture binding. A callback that does real work is not a sleep.
  Controlled `Effect.sleep`/TestClock and fake async callbacks under test are
  valid. Opaque Page factories/fixture wrappers are not guessed.
- The standard typed Promise warnings allow explicit `void` and async JSX
  handlers. Existing error-level rules are not relaxed.

## Narrow exceptions

Use an ESLint line suppression with a concrete explanation when elapsed time or
an integration effect is the behavior under test. Prefer deterministic completion
signals for ordinary tests. Do not blanket-disable a rule to silence an audit.

The configuration documents editable settings drafts (`setDraft`), the command
input's selected-draft reconciliation (`setInputValue`), and native editor theme
integration (`EmbeddedEditorStore.updateTheme`). These exceptions only exempt the
named setter/method in the named files; other Store workflows still warn.
`nonReactiveFields` identifies intentional ConversationModeStore audio buffers,
queues and bookkeeping, not all private fields. Supervision exceptions are an
explicit list of runtime sites, not a backend-wide exemption. Add exceptions
only when their ownership contract is understood; never automatically relocate
code or auto-fix architectural warnings.
