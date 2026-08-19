# Cake agent instructions

## What Cake is

Cake is Pi expressed as a desktop GUI. Pi remains the coding-agent engine; Cake
does not reimplement its agent loop, providers, tools, extensions, skills,
compaction, or session format. Cake makes Pi's work navigable across projects
and sessions and uses the web platform for interactions that a terminal cannot
express well: rich transcripts, diffs, artifacts, forms, diagrams, media, and
trusted user-authored React plugins.

Cake is also a layer above any one Pi session. It presents the user's collection
of projects and sessions, lets them move among and compare those sessions, and
provides application-level workflows such as global chat. Global chat is a
Pi-backed meta-session for reasoning about and navigating Cake as a whole; it is
not a replacement transcript authority for project sessions.

The conversation remains primary. Rich surfaces should appear because they help
the current work, not because Cake is trying to become a general-purpose IDE.

See `docs/architecture/cake-architecture.md` for the process, authority, trust,
state, and development boundaries behind these principles.

## Required reading

- Read `docs/architecture/cake-architecture.md` before changing architecture or
  feature ownership.
- For renderer state work, read the available `r-state-tree` skill and the references it routes to before editing.
- For plugins, scenes, widgets, or plugin recovery, read the available
  `cake-plugin-authoring` skill before editing.

## Core ownership rules

- Pi owns agent sessions, transcript history, model/provider state, tool loops,
  compaction, branching, and the Pi JSONL format.
- Cake owns the desktop application model, project/session navigation, renderer
  projections, window and workflow state, artifacts, reviews, plugin metadata,
  and other GUI-specific persistence. Never create a second Cake-owned copy of
  a Pi transcript.
- `src/agent` is the Pi adapter layer. Other Cake modules use
  Cake-owned contracts and intent-level operations rather than raw Pi objects.
- Electron main owns Pi runtimes, filesystem access, persistence, and native
  services. Preload exposes one narrow validated bridge. The sandboxed renderer
  owns React presentation and window-scoped Stores; it has no Node globals or
  raw Electron IPC.
- Cross-process data is untrusted until parsed by the shared runtime schemas.
- Global chat is an application-level Pi session. Keep it separate from project
  session lists and use curated Cake control intents for application navigation
  and coordination.
- Model-presented artifacts are data and remain validated or sandboxed. A user
  plugin is executable, trusted renderer source only after explicit approval;
  it still receives no direct Node, Electron, credentials, raw IPC, or raw Pi
  access.
- The immutable core shell, global chat, plugin diagnostics, and recovery UI
  must be able to boot without evaluating user plugin code. A broken plugin must
  be repairable or disableable without making Cake unusable.

## Greenfield compatibility policy

- Cake is a greenfield project. Unless the user explicitly requests it, do not preserve backward compatibility.
- Remove replaced APIs and implementations outright. Do not add deprecated aliases, compatibility shims, transitional forwarding facades, legacy import paths, migrations, or fallback behavior for code being replaced.
- Prefer updating every caller, test, and document in the same change over carrying an old interface forward.

## UI composition and reuse

- Before introducing any UI element, first inspect the existing renderer components and compose the closest existing primitive or product component. Start with `src/renderer/components`, especially `components/ui` for primitives and `components/ai-elements` for conversation, Markdown, code, tool, and source surfaces; also inspect `src/renderer/cake.ts` for the components already exposed to plugins.
- Do not recreate an existing control, source viewer, syntax highlighter, layout primitive, or interaction under a new name. Extend the authoritative component when a shared capability is missing, then update all consumers that need it.
- Every chat of every kind—project-session, Cake Chat, pop-up, selection,
  comment, review, inline, modal, plugin, recovery, secondary, and any future
  chat surface—must render the authoritative `Chat` component from
  `src/renderer/components/chat.tsx` and supply an instance of the shared
  `ChatStore` from `src/renderer/stores/ChatStore.ts`. Extend those shared
  abstractions when a chat needs new behavior; never build a parallel chat
  component, transcript, input, composer, message renderer, Store contract, or
  chat-specific control set. Surface-specific framing and context may wrap the
  shared chat, but must not replace its conversation behavior or controls.
- Add a new component only when the element has a genuinely distinct responsibility that cannot be expressed by composing or extending the existing component set.
- Keep one named React component per source file by default. Small anonymous render callbacks are fine, but independently named pages, fields, panels, and controls belong in their own files unless colocation has a concrete technical benefit.

## Renderer state architecture

- Treat each Store as a stateful behavioral component with one cohesive product or workflow responsibility.
- `RootStore` is the renderer composition root and event-routing boundary. A window-scoped lifetime does not make `RootStore`, a shell Store, or a generically named window-scoped Store the owner of every workflow in that window.
- Give named product surfaces named Stores: navigation/sidebar, project selection, active session/chat, changes, reviews, browse, settings, and similar independently evolving workflows.
- Compose Stores according to ownership and lifetime. Put a shared Store near the root; nest it only when its lifetime and behavior are truly owned by one parent surface.
- Parent Stores coordinate cross-Store work. They must not duplicate child state or expose one-for-one forwarding facades for a child's API.
- Existing concentration of unrelated state is a refactoring signal, not precedent for adding the next field or method there.
- Keep only tiny DOM, focus, hover, measurement, or isolated input state in React. Workflow state, async policy, persistence, subscriptions, and timers belong to a Store.

Before adding state, identify its authority, cohesive owner, lifetime, persistence boundary, and concurrency policy. If the proposed owner cannot be described without saying "everything in this window" or listing unrelated surfaces, introduce or use a focused Store instead.

## Strict model and Store organization

- Every r-state-tree model and every Store must live in its own file. Never colocate multiple models or Stores, or mix them with utilities or unrelated code.
- All r-state-tree models must live under the source-root `/models` directory (`src/models/`), and that directory must contain nothing except r-state-tree model files. Model names and filenames must be PascalCase and must never end in `Model`.
- All Stores must live under the source-root `/renderer/stores` directory (`src/renderer/stores/`), and that directory must contain nothing except Store files. Store names and filenames must be PascalCase and must end in `Store`.
- Relocate utilities and other supporting code to `/utils` (`src/utils/`) or the appropriate domain directory; do not place them in `/models` or `/renderer/stores`.

## Verification

Format changed supported files with Oxfmt before final verification. Use
`pnpm format` to format the repository and `pnpm format:check` to verify that no
formatting changes remain.

Run Oxlint for every source-code change with `pnpm lint:oxlint`; do not rely on
ESLint alone. Run `pnpm lint` for final lint verification when the task's scope
permits, since it runs Oxlint first and then ESLint. Run focused tests and the
relevant typecheck or build for the files changed. Preserve unrelated worktree
changes.

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
