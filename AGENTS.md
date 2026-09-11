# Cake agent instructions

## User-directed overrides

The user owns this repository and may explicitly override any rule in this file for a task. Follow the user's stated exception without requiring them to edit this file first. This does not override system or harness-level instructions outside this repository.

## What Cake is

Cake is Pi expressed as a desktop GUI. Pi remains the coding-agent engine; Cake
does not reimplement its agent loop, providers, tools, extensions, skills,
compaction, or session format. Cake makes Pi's work navigable across projects
and sessions and uses the web platform for interactions that a terminal cannot
express well: rich transcripts, diffs, artifacts, forms, diagrams, and media.

Cake is also a layer above any one Pi Session. It presents the user's
collection of Projects and Cake Sessions, lets them move among and compare
those sessions, and provides application-level workflows such as Cake Chat. A
Cake Chat Session is a Pi-backed meta-session for reasoning about and navigating
Cake as a whole; it is not a replacement transcript authority for Project
Sessions.

The conversation remains primary. Rich surfaces should appear because they help
the current work, not because Cake is trying to become a general-purpose IDE.

See `docs/architecture/cake-architecture.md` for the process, authority, trust,
state, and development boundaries behind these principles.

## Architecture and library guidance

Consult documentation proportionally while investigating and implementing; do
not treat exhaustive reading as a prerequisite to making the first focused
code change.

- For architecture or feature-ownership changes, consult the relevant sections
  of `docs/architecture/cake-architecture.md`,
  `docs/architecture/cake-vocabulary.md`, and
  `docs/architecture/effect-architecture.md` before finalizing the design.
- For renderer-state changes, inspect the existing Cake Models/Stores and consult
  the relevant r-state-tree `README.md`, skill, or references for the APIs and
  ownership decisions being changed. Classify authority, owner, lifetime,
  persistence, and concurrency as part of the implementation.
- For Effect code, use `.agents/skills/effect-ts/SKILL.md`, the installed
  `node_modules/effect/AGENTS.md`, and their relevant linked references as
  targeted guidance. Cake architecture decides ownership and process boundaries;
  the installed Effect package is the API authority; the local skill defines
  Cake's Effect coding conventions within those boundaries.
- When guides do not answer a particular Effect API question, inspect the pinned
  implementation in `node_modules/effect/src`.

## Core ownership rules

- Pi owns agent sessions, transcript history, model/provider state, tool loops,
  compaction, branching, and the Pi JSONL format.
- Cake owns the desktop application model, project/session navigation, renderer
  projections, window and workflow state, artifacts, reviews, and other
  GUI-specific persistence. Never create a second Cake-owned copy of
  a Pi transcript.
- `src/services/pi` is the target Pi Service boundary. During migration,
  focused legacy adapters may remain in `src/agent`, but no new Pi integration
  belongs there. Other Cake modules use Cake-owned values and domain operations
  rather than raw Pi objects.
- Electron main owns Pi runtimes, filesystem access, persistence, and native
  services. Preload exposes one narrow validated bridge. The sandboxed renderer
  owns React presentation and window-scoped Stores; it has no Node globals or
  raw Electron IPC.
- Cross-process data is untrusted until parsed by the shared runtime schemas.
- A Cake Chat Session is an application-level Cake Session backed by Pi. Keep
  it separate from Project Session lists and use curated Cake control intents
  for application navigation and coordination.
- Model-presented artifacts are data and remain validated or sandboxed.

## Greenfield compatibility policy

- Cake is a greenfield project. Unless the user explicitly requests it, do not preserve backward compatibility.
- Remove replaced APIs and implementations outright. Do not add deprecated
  aliases, compatibility shims, transitional forwarding facades, legacy import
  paths, or fallback behavior for code being replaced. Versioned migrations for
  persisted user data are an explicit storage responsibility and are not API
  compatibility shims.
- Prefer updating every caller, test, and document in the same change over carrying an old interface forward.
- Do not add tests solely to assert that a feature or DOM element removed outright is absent. Remove obsolete tests for removed features; test absence only when conditional or state-dependent absence is itself the behavior under contract.

## Renderer implementation standard

Before implementing renderer UI:

1. Inspect `src/renderer/components`, especially `components/ui` for primitives
   and `components/ai-elements` for conversation, Markdown, code, tool, and
   source surfaces.
2. Identify the existing primitive, product component, Store, and Model that
   own the behavior. Existing one-off implementations are migration debt, not
   precedent.
3. If the work touches application state, classify every state value by
   authority, owner, lifetime, persistence boundary, and concurrency policy.
   Keep Effect and transport mechanics behind renderer client and projection
   infrastructure rather than importing them into ordinary Stores.

### Tailwind and styling

- Tailwind utilities and shared UI primitives are the sole styling mechanism for
  renderer components.
- Do not add product-specific, layout, or component-specific CSS classes to
  `src/renderer/styles.css`. Do not create component stylesheets, CSS modules,
  CSS-in-JS, or inline styles for static presentation.
- `styles.css` is strictly restricted to Tailwind directives, theme variables and
  mappings, base element rules, keyframes, third-party integration selectors (such
  as Shiki syntax tokens), and browser or Electron behavior that Tailwind cannot express.
- Dynamic geometry may use a narrowly typed React style object, preferably to
  set CSS custom properties. It must not encode static colors, spacing,
  typography, borders, shadows, or other ordinary presentation.
- Compose conditional classes with `cn()` from
  `src/renderer/lib/utils.ts`. Do not manually concatenate class strings.
- Reuse existing semantic theme tokens. A new semantic color requires light
  and dark variables plus an `@theme inline` mapping. Do not hard-code product
  colors in components.

### Components and controls

- Whenever introducing a visual or interactive pattern, it must be created as a
  shared UI component in `src/renderer/components/ui/` and added to the component
  catalog. Never build one-off, inline interactive elements or feature-local
  substitute widgets.
- Feature TSX files must **never** render raw interactive HTML elements directly
  (e.g. `<button>`, `<input>`, `<select>`, `<textarea>`). All interactive
  surfaces must compose authoritative components from `src/renderer/components/ui/`
  (`Button`, `IconButton`, `NavItem`, `DisclosureTrigger`, `ActionCard`, `Chip`,
  `Input`, `Select`, `Textarea`, `Switch`, `SegmentedControl`, `Badge`, `Card`,
  `Callout`, `Dialog`, `Popover`, `EmptyState`, etc.).
- Raw HTML interactive elements are strictly restricted to the internal
  implementation of authoritative primitives in `src/renderer/components/ui/`.
- Compose the closest existing primitive or product component before creating
  a component. Do not recreate an existing control, source viewer, syntax
  highlighter, layout primitive, or interaction under another name.
- Do not create a feature-local button, input, select, textarea, dialog,
  popover, tooltip, toggle, loading treatment, code viewer, or source viewer
  when an authoritative component exists.
- Add a component only when it has a genuinely distinct responsibility that
  cannot be expressed by composing or extending the existing component set.
- A feature source file exports exactly one named React component.
  Independently meaningful subcomponents belong in separate files. Exceptions
  are cohesive compound primitive APIs, the centralized icon catalog, and tiny
  private render helpers with no independent responsibility.
- Every chat of every kind—project-session, Cake Chat, pop-up, selection,
  comment, review, inline, modal, secondary, and any future
  chat surface—must render the authoritative `Chat` component from
  `src/renderer/components/chat.tsx` and supply an instance of the shared
  `ChatStore` from `src/renderer/stores/ChatStore.ts`. Extend those shared
  abstractions when a chat needs new behavior; never build a parallel chat
  component, transcript, input, composer, message renderer, Store contract, or
  chat-specific control set. Surface-specific framing and context may wrap the
  shared chat, but must not replace its conversation behavior or controls.

### Icons

- `src/renderer/components/ui/icons.tsx` is the sole icon authority.
- Do not define inline SVGs, SVG path data, icon wrapper components, Unicode
  glyph substitutes, or feature-local icon components. Add a missing icon to
  the shared catalog and reuse it.
- Decorative icons must be `aria-hidden`. Icon-only actions must use the shared
  `IconButton` and provide a tooltip and accessible name.

## Renderer state architecture

- Treat each Store as a stateful behavioral component with one cohesive product or workflow responsibility.
- `RootStore` is the renderer composition root and event-routing boundary. A window-scoped lifetime does not make `RootStore`, a shell Store, or a generically named window-scoped Store the owner of every workflow in that window.
- Give named product surfaces named Stores: navigation/sidebar, project selection, active session/chat, changes, reviews, browse, settings, and similar independently evolving workflows.
- Compose Stores according to ownership and lifetime. Put a shared Store near the root; nest it only when its lifetime and behavior are truly owned by one parent surface.
- Parent Stores coordinate cross-Store work. They must not duplicate child state or expose one-for-one forwarding facades for a child's API.
- Existing concentration of unrelated state is a refactoring signal, not precedent for adding the next field or method there.
- Keep only tiny DOM, focus, hover, measurement, or isolated input state in React. Workflow state, async policy, persistence policy, and workflow timers belong to a Store. Focused window-owned observers consume authoritative RPC Streams through the renderer runtime's common observation primitive and own their cancellation handles. The Model observer applies authoritative snapshots with `applySnapshot` and reduces ordered events transactionally, using direct, batched Model mutations for incremental entity changes. One-way window snapshot transport is renderer infrastructure outside the Store tree.
- Ordinary Stores and Models do not import Effect, Effect RPC, Layers, Fibers, raw transport contracts, the Model observer, or window snapshot transport. Stores invoke the typed Promise-based `Client` and read Models. Renderer bootstrap attaches synchronization and persistence infrastructure to the mounted Root Store.

Before adding state, identify its authority, cohesive owner, lifetime, persistence boundary, and concurrency policy. If the proposed owner cannot be described without saying "everything in this window" or listing unrelated surfaces, introduce or use a focused Store instead.

## Strict Model and Store organization

- Every r-state-tree Model and Store lives in its own file. Never colocate
  multiple Models or Stores or mix them with utilities or unrelated code.
- Renderer projection Models target `src/renderer/models/`, which contains only
  r-state-tree Model files. Model names and filenames are PascalCase and never
  end in `Model`. Existing files may remain in `src/models/` until their vertical
  ownership move; do not convert their state framework while relocating them.
- Stores live in `src/renderer/stores/`, which contains only Store files. Store
  names and filenames are PascalCase and end in `Store`.
- Main-owned application/storage data is ordinary Effect Schema data and must
  not be represented as a renderer Model.
- Relocate utilities and supporting code to `src/utils/` or the appropriate
  service/domain directory; do not place them in Model or Store directories.

## Review proportionality

- Calibrate findings to this product's actual risk. Reserve P0/P1 for common or
  severe failures such as data loss, security breaches, or a core workflow being
  unusable—not speculative races involving advisory metadata.
- Do not manufacture complexity in the name of defensive programming. If an edge
  case is rare, recoverable, and low impact, either omit it or label it plainly as
  minor; do not propose coordination, caching, migration, or abstraction machinery
  without demonstrated need.
- Separate product defects from repository-policy cleanup and optional polish.
  Prioritize direct requirement gaps and reproducible user-visible failures.
- Recommend the smallest understandable fix that solves the observed problem. Cake
  is a coding agent, not safety-critical infrastructure.

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

Default `pnpm test` runs only fast unit tests; tests that drive real external
services (git, Vite/esbuild bundling, the Pi runtime) live in
`tests/integration` and run with `pnpm test:integration` — usually in CI or for
an explicitly requested verification pass, not per change.

Do not run the full e2e suite for every change. Run only the targeted e2e tests
that could actually be affected by the change (same components, stores, or
features). Leave full-suite runs to CI or an explicitly requested verification
pass.

### Electron UI verification

- Cake is an Electron application. Do not use a localhost browser page to verify Cake UI unless the task explicitly targets a separately identified web surface.
- Renderer behavior that depends on focus, text selection, portals, keyboard input, or native DOM events must be verified through an isolated Playwright Electron test.
- Electron smoke tests run the compiled `out/` application. Run `pnpm build` after the final source change and before interpreting smoke-test results.
- Do not treat jsdom or a browser-only render as proof of focus, controlled-input, text-selection, or portal behavior.
- A chat-composer test must verify focus, actual typing, retained value, and enabled submission, not merely that a textarea rendered.
- Markdown selection tests must cover fenced code as well as prose. Wait for asynchronous syntax highlighting to settle before measuring text coordinates or simulating a drag.

### Debugging discipline

- Reproduce a reported UI defect in the smallest real Electron fixture before refactoring shared abstractions.
- After two failed implementation hypotheses, stop changing architecture. Summarize the evidence, identify the unresolved boundary, and choose one narrow experiment.
- Remove temporary diagnostics before broader verification.
- Do not broaden a surface-specific fix into `Chat`, `ChatStore`, or another shared primitive unless the behavior belongs to every consumer.
- When a shared chat primitive changes, run Electron smoke tests for the affected secondary chat, normal project chat input, and slash-command keyboard handling.
