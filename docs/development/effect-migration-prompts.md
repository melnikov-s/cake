# Effect migration agent prompts

This runbook contains copyable prompts for the complete Effect migration. Use
one work packet per fresh Cake worktree/session. Packets are ordered and may be
split further when the current implementation demonstrates a smaller safe
vertical slice.

The normative design is not repeated here. Every agent reads the architecture
and current migration handoff before editing. The progress table in
[`effect-migration.md`](./effect-migration.md) is the authority for what has
actually landed.

Custom Renderer is deliberately absent. It is unimplemented and outside this
migration.

## Common execution contract

Every prompt below incorporates these requirements:

1. Read `AGENTS.md`, `.agents/skills/effect-ts/SKILL.md`, every branch
   reference that skill routes to for the packet, the complete installed
   `node_modules/effect/AGENTS.md`, `docs/architecture/cake-architecture.md`,
   `docs/architecture/cake-vocabulary.md`,
   `docs/architecture/effect-architecture.md`, the focused architecture
   documents relevant to the packet, and
   `docs/development/effect-migration.md` completely. Cake architecture decides
   ownership; the installed package decides APIs; the local skill decides
   Effect coding conventions within those boundaries.
2. For renderer state work, also read
   `/Users/user/dev/effect-state-tree/README.md`, Cake's vendored
   `.agents/skills/effect-state-tree/SKILL.md`, and every linked reference
   completely.
3. Verify repository state, prior-phase completion, and local package state.
   Never infer completion from this runbook.
4. State the authority, owner, lifetime, persistence boundary, and concurrency
   policy of every state/resource changed.
5. Follow the local Effect conventions: function-valued named Service
   operations, correct `optionalKey` versus explicit-`undefined` Schema
   semantics, non-throwing validation at runtime boundaries, intentional Layer
   composition, Effect-managed caching/concurrency/resources, typed recovery
   that preserves interruption, and deterministic Effect tests.
6. Work vertically and remove the replaced path in the same packet. Do not add
   permanent compatibility aliases, duplicate protocols, duplicate state
   owners, or a second Pi transcript/event authority.
7. Preserve the renderer sandbox and main/preload/RPC privilege boundary.
8. Keep Custom Renderer out of scope.
9. Format, lint, typecheck, test, build, and run focused integration/Electron
   tests proportionate to the packet. Electron smoke tests execute `out/` and
   require a current build.
10. Update the migration progress notes with what landed, what remains, and the
    next exact entry point. Mark a phase complete only when all of its exit
    criteria pass.
11. Commit the completed packet with a focused message and leave the worktree
    clean. Preserve unrelated changes.

## Effect conventions alignment gate

Run this once against all Effect code landed so far before continuing the next
migration packet. It is also the copyable prompt for a future conventions
re-audit.

```text
Align Cake's existing Effect implementation with the repository's complete
Effect best-practices skill before continuing feature migration. This is a
conventions and correctness pass, not a product or architecture redesign.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`. In particular, read
`.agents/skills/effect-ts/SKILL.md`, every reference it routes to for the code
under review, and `node_modules/effect/AGENTS.md` completely. Review the current
migration progress and repository state rather than assuming which phases have
landed.

Scope:
- Inventory every current Effect Service, Layer, Schema, domain operation,
  runtime boundary, Stream, cache/resource registry, and Effect-focused test.
- Make zero-argument Service operations function-valued and name public and
  non-trivial internal operations with `Effect.fn`.
- Correct `Schema.optionalKey` versus `Schema.optional` according to the actual
  encoded storage/RPC contract. Use same-name interfaces for new or touched
  Effect-owned records without creating unrelated schema churn.
- Replace throwing or cast-based untrusted runtime decoding with effectful or
  explicit non-throwing validation and typed boundary failures.
- Replace hand-rolled memoization, pending-Promise deduplication, TTL maps,
  Fiber registries, and repeated-work loops with the appropriate Effect
  primitive while preserving exact lifetime, failure-caching, and concurrency
  semantics.
- Make Layer constructors, `provide`/`provideMerge`, acquisition, exposed
  dependencies, and Scope ownership intentional and legible. Preserve exactly
  one main ManagedRuntime and one renderer runtime per window.
- Keep Cake business policy in free domain Effects and outside-world access in
  Services. Do not convert domain modules into Context Services.
- Audit broad catches, retries, timeouts, and fallbacks so expected errors stay
  typed, interruption is preserved, retries are idempotent and bounded, and a
  fallback catches only failures for which it is truthful.
- Add `@effect/vitest` if required and migrate the Effect-focused tests touched
  by this pass to `it.effect`, Test Layers, `TestClock`, and deterministic
  synchronization. Do not rewrite unrelated React or Electron tests.
- Remove non-null assertions, `as any`, and unchecked casts from the reviewed
  Effect paths. A cast after complete Schema validation requires a documented,
  narrow library-typing reason or should be removed.
- Preserve Cake's authority model, process security boundary, Pi transcript
  ownership, greenfield removal policy, and current product behavior.

Verify format, lint, typecheck, unit tests, build, focused integration tests,
and the Electron tests for every changed runtime boundary. Update
`docs/development/effect-migration.md` with the conventions alignment result and
the next exact migration entry point. Commit the alignment as its own focused
packet and leave unrelated work untouched.
```

## Packet 0 — Effect and effect-state-tree dependencies

```text
Implement Phase 0 of Cake's Effect migration. Do not begin Phase 1.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, then the complete Phase 0
instructions and exit criteria in `docs/development/effect-migration.md`.

Scope:
- Add Effect `4.0.0-rc.111` as Cake's direct dependency.
- Add unpublished local `effect-state-tree` consumption.
- Ensure Cake and effect-state-tree resolve one Effect and one React instance.
- Do not install `@effect/rpc`; later work uses `effect/unstable/rpc`.
- Update the pnpm lockfile.
- Verify the dependency graph resolves one Effect and React instance, then run
  Cake's typecheck and production build without adding an import-only test. The
  first real renderer slice supplies effect-state-tree behavioral coverage.
- Add Vite deduplication only if resolution evidence requires it.
- Run the local effect-state-tree typecheck/tests and Cake's proportional
  verification.

Local path caveat:
The committed dependency must resolve from `/Users/user/dev/cake` as
`file:../effect-state-tree`. A Cake worktree has a different relative path. You
may create an uncommitted local symlink at the expected sibling location or use
a temporary local override, but do not commit an absolute or worktree-specific
path. Verify the committed path from the main-checkout layout before finishing.

Out of scope:
- MainLive/MainApplication;
- Effect RPC;
- Services/domain modules;
- application Store or Model migration;
- product behavior changes.

Update only Phase 0 progress, commit the packet, and identify Phase 1's exact
entry point.
```

## Packet 1 — Main Effect runtime

```text
Implement Phase 1 of Cake's Effect migration: establish the main Effect runtime.
Do not begin Effect RPC or migrate product capabilities.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, then Phase 1 and its exit
criteria in `docs/development/effect-migration.md`. Confirm Phase 0 is complete;
if it is not, stop and report the unmet prerequisite rather than absorbing it.

Scope:
- Add `src/main/MainLive.ts`, `MainApplication.ts`, and `BootstrapLive.ts`.
- Create exactly one main ManagedRuntime.
- Wrap Electron startup/shutdown and bind root Scope closure to application
  shutdown.
- Provide only the Effect Platform capabilities required to establish the
  runtime boundary.
- Establish named logging/tracing and top-level defect reporting.
- Make `src/main/main.ts` delegate lifecycle while preserving all existing IPC
  and product behavior.
- Add focused tests for startup, shutdown, finalization, and failed bootstrap.

Constraints:
- Do not create parallel runtimes from feature modules.
- Do not move all of `main.ts` or introduce speculative Services.
- Do not begin RPC, Pi, storage, or renderer migration.
- Bootstrap must not evaluate user plugin code.

Run proportional verification, update Phase 1 progress, commit, and record the
first Phase 2 transport entry point.
```

## Packet 2 — Effect RPC over Electron

```text
Implement Phase 2 of Cake's Effect migration: make Effect 4 RPC work through the
real Electron main/preload/renderer boundary.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, `foundation-boundaries.md`, and
Phase 2 of `effect-migration.md`. Confirm Phases 0 and 1 are complete.

Scope:
- Use `effect/unstable/rpc`, never `@effect/rpc`.
- Create the target `src/ipc/protocol`, `client`, `server`, and `transport`
  boundaries.
- Implement Electron client/server Protocol adapters and the narrow preload
  transport.
- Prove through focused Electron tests:
  1. one query success;
  2. one Schema-decoded typed failure;
  3. one streaming RPC;
  4. interruption of one long-running request;
  5. request/subscription cleanup when the renderer window closes.
- Carry renderer connection and tracing/correlation metadata through middleware.
- Add a temporary Promise facade over the generated Effect client for existing
  renderer callers.
- Migrate and remove at least one real legacy `desktop-ipc` operation end to
  end; do not leave two schemas for that operation.

Constraints:
- Preload is transport-only and exposes no raw `ipcRenderer`.
- RPC handlers delegate; they contain no Cake business logic.
- Do not migrate all desktop operations in this packet.
- The Promise facade is explicitly temporary and must not define a second
  protocol.

Run unit, integration, build, and focused Electron verification. Update Phase 2
progress, commit, and record the storage operation that begins Phase 3.
```

## Packet 3 — Typed file storage and application state

```text
Implement Phase 3 of Cake's Effect migration: focused typed file storage and
main-owned application state. Do not migrate renderer projection Models yet.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, `cake-storage.md`, and Phase 3
of `effect-migration.md`. Confirm Effect RPC is available.

Scope:
- Introduce focused Effect storage Service contracts and shared internal atomic
  file machinery without exposing a generic untyped key/value Service.
- Implement explicit version envelopes, sequential migrations, current Effect
  Schema decoding, temporary-write/atomic-rename behavior, and typed failures.
- Extract authoritative application data and behavior from
  `src/models/Application.ts` into ordinary stored/domain Schema values and
  free domain Effects.
- Preserve Projects, trust, resolution/archive metadata, utility preference,
  Model Presets, VS Code Server path, and other existing Cake-owned facts.
- Keep Pi JSONL, Pi credentials, artifacts, reviews, plugins, and their existing
  authorities intact unless a focused storage adapter must be introduced.
- Route migrated application persistence through Effect RPC where renderer
  access is required and remove the replaced legacy operation/schema.
- Test missing, current, older, malformed, future-version, interrupted-write,
  and atomic replacement behavior.

Constraints:
- `Application` must not become a renderer effect-state-tree Model.
- Do not introduce a database without evidence matching the storage contract.
- Do not migrate Model Preset UI; that is Packet 4.
- Do not persist Pi transcript projections.

Run proportional verification, update Phase 3 progress, commit, and identify the
exact old Model Preset path for Packet 4.
```

## Packet 4 — Model Presets vertical slice

```text
Implement Phase 4: migrate Model Presets as the first complete vertical Effect
slice.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, the model vocabulary, and Phase
4 of `effect-migration.md`. Confirm typed application storage and Effect RPC are
complete.

Scope:
- Implement the Cake-facing portion of `PiModels` needed for provider/model
  catalog, authentication/availability, reference resolution, and supported
  thinking levels. Keep it narrow enough for this slice.
- Add cohesive free domain operations in `src/domain/modelPresets.ts` for list,
  create, update, remove, and resolve.
- Persist presets through the focused typed storage Service.
- Preserve unresolved presets and return typed resolution failures; never
  silently substitute a model.
- Add/replace the `modelPresets` RPC group.
- Migrate `ModelPresetSettingsStore` to effect-state-tree if renderer migration
  prerequisites are ready; otherwise use only the already-approved temporary
  Promise facade and leave one precise renderer follow-up. Do not create two
  Store authorities.
- Remove all replaced Model Preset IPC handlers, schemas, and application-model
  methods in the same packet.
- Use `thinkingLevel` in all new contracts.

Test domain behavior with PiModels Test Layer and in-memory storage, then prove
the real Electron path. Update Phase 4 only when its complete exit criteria are
met, commit, and identify the first remaining Pi service module.
```

## Packet 5A — PiModels and PiAgentResources

```text
Continue Phase 5 by completing `PiModels` and implementing
`PiAgentResources`. Do not migrate live Pi Session runtimes yet.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, `pi-0.84-contract.md`,
`s3-pi-compatibility.md`, and Phase 5 of `effect-migration.md`.

Scope:
- Consolidate current model catalog, authentication/availability, reference
  resolution, and bounded non-session completion behind `PiModels`.
- Implement `PiAgentResources` for context-dependent skills, prompt templates,
  configured Pi Extension sources, discovery, reload, and diagnostics.
- Move the relevant Pi package imports beneath `src/services/pi`.
- Keep pure Pi-to-Cake translation as ordinary modules.
- Preserve utility completion as bounded, transcript-free Pi model execution;
  Cake feature retry/fallback policy remains in domain code unless it is an
  intrinsic Pi adapter policy.
- Keep executable Pi Extension lifecycle out of `PiAgentResources`.
- Replace relevant legacy adapters and callers rather than forwarding through
  them permanently.

Constraints:
- No generic LLM abstraction.
- No `PiExtensions` Service.
- Do not start `PiSessions` migration in this packet.

Test with deterministic Pi fixtures/Test Layers, update Phase 5 as partially
complete, commit, and name the runtime-construction entry point for Packet 5B.
```

## Packet 5B — PiSessions and scoped runtime acquisition

```text
Complete Phase 5 by implementing `PiSessions` and moving all remaining ordinary
Pi package imports beneath `src/services/pi`.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, `pi-0.84-contract.md`,
`s1-session-contract.md`, `s3-pi-compatibility.md`, and Phase 5 of the migration
handoff. Confirm Packet 5A has landed.

Scope:
- Implement list, inspect, and keyed scoped acquire with the appropriate Effect
  keyed-resource primitive. Do not hand-roll a mutable Map of runtimes,
  pending Promises, or Fibers.
- Define `PiSessionHandle` observation and operations: prompt, steer,
  follow-up, abort, commands, model/thinking configuration, compact, fork, and
  reload as required by existing behavior.
- Share one process-local runtime for concurrent acquisition of one Pi Session;
  final release disposes it. Reject conflicting runtime-defining options.
- Define semantic capability profiles for Project Session, Cake Chat Session,
  Discussion Session, and Subagent Session.
- Bind Pi Extensions and Cake's supported UI adapter within the session runtime.
- Emit one Pi-authoritative initial snapshot followed by live typed events
  without tailing JSONL directly.
- Preserve retry, recovery, command, resource, trust, and disposal behavior.
- Move or replace session discovery/projection/runtime code from `src/agent` and
  current main drivers as far as this Service boundary permits.
- Enforce with tests or lint that ordinary Pi imports now exist only beneath
  `src/services/pi`.

Constraints:
- Do not implement Cake Session business modules yet.
- Do not expose raw Pi objects or backing private Subagent Pi IDs.
- Do not create a durable Cake event/transcript log.

Run deterministic Pi contract, Scope sharing/finalization, and integration
tests. Mark Phase 5 complete only when its exit criteria pass, commit, and
record the first Project Session domain operation for Packet 6A.
```

## Packet 6A — Shared Cake Session domain and Project Sessions

```text
Begin Phase 6 by implementing shared Cake Session domain behavior and migrating
Project Sessions above `PiSessions`.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, `cake-vocabulary.md`,
`s1-session-contract.md`, and Phase 6 of the migration handoff. Confirm all Pi
Services are complete.

Scope:
- Add cohesive free Effect modules `conversations.ts` and
  `projectSessions.ts`; do not create Context services for Cake domain logic.
- Centralize shared Cake Session identity, capability selection, acquisition,
  and Pi-to-Cake Snapshot/Event projection in conversation domain functions.
- Migrate Project Session list/inspect/create/open/prompt/steer/follow-up/abort,
  fork, rename, resolve, restore, and observation behavior required by current
  Cake.
- Preserve Project and Working Directory association, trust, Managed Worktree
  context, archive policy, complete active-branch display, queues, and
  settled-turn rules.
- Add/replace Project Session Effect RPC operations and streaming subscription.
- Return accepted Turn IDs from commands and report lifecycle through Updates.
- Remove the replaced Project Session handler/driver paths; document any
  narrowly remaining driver responsibility for later packets.

Constraints:
- Renderer may remain behind the temporary Promise facade in this packet.
- No parallel conversation engine or transcript store.
- Do not migrate Cake Chat, Discussion, or Subagent behavior yet.

Test with PiSessions Test Layer and the real Electron boundary. Record Phase 6
as partial, commit, and identify the Cake Chat path for Packet 6B.
```

## Packet 6B — Cake Chat and Discussion Sessions

```text
Continue Phase 6 by migrating Cake Chat Sessions and Discussion Sessions onto
the shared Cake Session domain above `PiSessions`.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, `cake-vocabulary.md`, review
contracts, and Phase 6 of the handoff. Confirm Packet 6A is complete.

Scope:
- Add cohesive `cakeChats.ts` and `discussionSessions.ts` free Effect modules.
- Reuse shared `conversations.ts`; do not create separate runtime engines.
- Preserve Cake Chat separation from Project Session catalogs, pending-first-
  prompt behavior, curated Cake controls, resolution/archive behavior, and
  application-level context.
- Preserve review/message anchors as Cake facts and sidecar replies as Pi
  Session facts.
- Regenerate bounded read-only parent context before Discussion Session replies
  and preserve constrained tools/capabilities.
- Replace Cake Chat and Discussion query/command/subscription RPC paths and
  remove corresponding legacy driver/handler behavior.
- Keep the shared renderer `Chat`/`ChatStore` contract intact.

Constraints:
- Do not migrate Subagents yet.
- Do not copy parent transcripts into sidecar storage.
- Renderer Store conversion belongs to Phase 7 unless required to remove a
  duplicate authority safely.

Run domain and focused Electron tests, update Phase 6 as partial, commit, and
identify Subagent coordinator entry points for Packet 6C.
```

## Packet 6C — Subagent Sessions and stable activity handles

```text
Complete Phase 6 by migrating Subagent Sessions onto the shared Cake Session
domain and fixing activity identity at the domain/protocol boundary.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, the Subagent sections of
`cake-architecture.md`, and Phase 6 of the migration handoff.

Scope:
- Add cohesive free Effect operations in `subagents.ts` using `PiSessions` and
  shared conversation functions.
- Preserve parent ownership, capability profiles, model preflight, concurrency,
  recursion, retention, background/foreground semantics, steer, abort, wait,
  and cleanup.
- Use one stable parent-scoped Subagent handle for spawn, repeated wait,
  activity, completion, steer, and abort.
- Ensure polling/waiting never creates another logical activity item.
- Keep backing private Pi Session identity out of renderer RPC.
- Project live parts, tool activity, usage, cost, and final result through the
  stable handle and parent transcript policy.
- Replace legacy coordinator/protocol paths and add focused tests for duplicate
  waits, completion races, cancellation, parent disposal, and bounded parallel
  acquisition.

Constraints:
- Do not build the renderer's new running-subagent popover in this domain
  packet unless it is separately requested as a Phase 7 UI slice.
- No recursive delegation beyond documented policy.

Mark Phase 6 complete only when all Cake Session kinds use the common
`PiSessions` boundary. Commit and record the first renderer foundation step.
```

## Packet 7A — RendererLive and first effect-state-tree Store

```text
Begin Phase 7 by establishing the renderer Effect Layer/root mounting boundary
and migrating the bounded Model Preset/settings slice to effect-state-tree.

Read and follow the Common execution contract in
`docs/development/effect-migration-prompts.md`, including all required local
effect-state-tree documentation and references. Confirm the corresponding main
RPC slice is complete.

Scope:
- Add `RendererLive` providing `CakeIpcClient`.
- Mount Stores outside React with one owned root Scope.
- Establish `StoreProvider`/`useStore`/`observer` usage without changing Store
  lifetime semantics.
- Migrate Model Preset/settings reactive state from r-state-tree to
  effect-state-tree Models/Stores under `src/renderer/models` and
  `src/renderer/stores`.
- Acquire `CakeIpcClient` synchronously in Store initializers; close over it so
  public Effect methods have `R = never`.
- Put asynchronous load/observation in `autorun` after hydration.
- Remove the old Store/Model and temporary Promise calls for this slice.
- Add focused tests for mount/disposal, operation interruption, React facade,
  and Stream-to-Model reduction.

Constraints:
- Do not migrate RootStore or all providers at once.
- Do not construct Stores during React render.
- Do not add a second reactive graph or custom Atom registry.

Update Phase 7 as partial, commit, and identify the Project/Session catalog
slice for Packet 7B.
```

## Packet 7B — Project and Session catalogs

```text
Continue Phase 7 by migrating Project and Session catalog projections and their
focused Stores to effect-state-tree.

Read and follow the Common execution contract and all effect-state-tree
references. Confirm RendererLive and the first Store slice are stable.

Scope:
- Migrate `Project`, Session summary/catalog projection Models, and
  `ProjectCatalogStore`/`SessionCatalogStore`.
- Preserve stable identity, flat activity ordering, project grouping indexes,
  resolved status, unread state, and stale-event filtering.
- Consume `CakeIpcClient` query/subscription APIs and reduce Updates into Models
  with immutable Ref writes and `batch`.
- Keep Project selection in renderer Stores and Project registration/business
  policy in main domain operations.
- Move migrated Models to `src/renderer/models` and delete their legacy
  `src/models` implementations.
- Test initial Snapshot, event ordering, reconnect replacement, stale target,
  identity collisions, and Scope cleanup.

Constraints:
- Do not migrate full Project Session/chat aggregates yet.
- Do not persist transcript or catalog copies merely to simplify hydration.

Commit the slice, update Phase 7 progress, and list chat leaf dependencies for
Packet 7C.
```

## Packet 7C — Chat leaf Models and Stores

```text
Continue Phase 7 by migrating the reusable chat leaf state needed by every Cake
Session surface.

Read and follow the Common execution contract, all effect-state-tree references,
and the authoritative shared Chat rules in `AGENTS.md`.

Scope:
- Migrate Message/part projection Models and focused chat configuration,
  composer, artifact interaction, comments, extension UI, and Subagent activity
  Stores in the smallest dependency-safe order.
- Keep every chat surface on the authoritative `Chat` component and shared
  `ChatStore`; do not create parallel transcript/composer abstractions.
- Consume Cake Session Updates through owning Stores and batch coherent part
  changes.
- Preserve current frame coalescing only where semantically replaceable; do not
  drop lossless transcript events.
- Keep isolated focus/measurement/input details in React and workflow drafts in
  Stores.
- Remove each old Store/Model immediately when its new slice lands.
- Test actual Electron composer focus, typing, retained value, enabled submit,
  slash commands, fenced-code selection where affected, and Store cleanup.

Constraints:
- Do not migrate aggregate registries/root routing until leaf dependencies are
  complete.
- Models remain inert and service-free.

Commit, update Phase 7 progress, and name aggregate dependencies for Packet 7D.
```

## Packet 7D — Project Session and Cake Chat aggregates

```text
Continue Phase 7 by migrating `ProjectSessionStore`, Cake Chat session Stores,
and their keyed registries/collections to effect-state-tree.

Read and follow the Common execution contract and all effect-state-tree
references. Confirm catalog and chat leaf slices are complete.

Scope:
- Migrate Session projection Models, `ProjectSessionStore`,
  `SessionRegistryStore`, Cake Chat session Store, and Cake Chat collection.
- Use stable domain keys and `Store.children` only for state-selected keyed
  children; compose always-present children directly.
- Preserve one loaded Store identity per Cake Session, background activity,
  pending/staged session semantics, configuration, drafts, artifacts, and
  shared Chat behavior.
- Subscribe through `CakeIpcClient`, reduce initial Snapshot plus Events, and
  resynchronize by replacing from a new authoritative Snapshot.
- Ensure lazy unrealized children start no hidden work and child replacement
  closes the correct Scopes.
- Remove corresponding r-state-tree implementations and Promise client calls.
- Test keyed reuse, changed generations, disposal, pending child hydration,
  session switching, Project Session input, Cake Chat input, and secondary chat
  behavior.

Constraints:
- Do not migrate RootStore by copying all behavior into it.
- Provider ancestry is lookup, not Store ownership.

Commit, update Phase 7 progress, and identify workbench/root dependencies for
Packet 7E.
```

## Packet 7E — Workbench, shell, RootStore, and remaining renderer state

```text
Complete Phase 7 by migrating the workbench/shell composition, RootStore event
routing, and remaining r-state-tree renderer Stores without changing product
ownership boundaries.

Read and follow the Common execution contract and all effect-state-tree
references. Confirm prior Phase 7 packets are complete.

Scope:
- Migrate `ProjectWorkbenchStore`, focused workflow children, `AppShellStore`,
  `SidebarStore`, `SettingsStore`, reviews/customization/plugin command Stores,
  `RootStore`, and any remaining renderer Store in dependency-safe slices.
- Keep RootStore as composition, cross-Store coordination, and event routing;
  do not absorb child state or add one-for-one forwarding APIs.
- Replace the legacy root desktop subscription with scoped `CakeIpcClient`
  subscriptions.
- Mount and dispose the root through Effect Scope and preserve React provider
  boundaries.
- Remove all remaining renderer `DesktopClient` dependencies that now have RPC
  equivalents.
- Remove each replaced r-state-tree Store/Model and its obsolete tests.
- Run affected normal chat, Cake Chat, discussion, command, review, plugin, and
  navigation Electron tests.

Constraints:
- Window snapshot persistence policy is Phase 8; preserve current behavior or a
  narrow bridge until that packet.
- Do not retain r-state-tree merely for an unreferenced legacy surface.

Mark Phase 7 complete only when all renderer state uses effect-state-tree and
its exit criteria pass. Commit and record Phase 8's exact persisted root.
```

## Packet 8 — Effect-state-tree window persistence

```text
Implement Phase 8: versioned renderer snapshot persistence through
WindowStateStorage.

Read and follow the Common execution contract, `cake-storage.md`, all
snapshot/lifecycle sections of effect-state-tree documentation, and Phase 8 of
the migration handoff. Confirm renderer state migration is complete.

Scope:
- Classify every candidate persisted field by authority and persistence need.
- Mark only Cake-owned renderer state with `Store.snapshot`.
- Define the versioned `WindowStateSnapshot` document and sequential migrations.
- Load/decode/migrate in main, then apply one complete Store snapshot before
  autoruns activate.
- Choose and test an explicit fallback for malformed/unmigratable data.
- Start scoped debounced `onSnapshot` writes only after hydration.
- Preserve staged unsent chats, drafts, selection, settings, panels, and other
  accepted window state.
- Exclude Pi transcript/resource projections, terminal output, handles,
  Streams, Fibers, operations, loading, and live errors.
- Remove the old persistence coordinator protocol/path after all callers move.

Tests must prove defaults cannot overwrite saved state, one batch emits one
snapshot, failed application rolls back, lazy children are not realized,
pending keyed snapshots hydrate before publication, and restart reconstructs
Pi projections from Pi.

Commit, mark Phase 8 complete, and identify the first remaining native vertical
slice.
```

## Packet 9A — Git and Managed Worktrees

```text
Begin Phase 9 with the Git and Managed Worktree vertical slice.

Read and follow the Common execution contract, Project/Repository/Working
Directory vocabulary, storage architecture, and Phase 9 of the handoff.

Scope:
- Implement concrete `Git` Service operations required by Cake.
- Keep filesystem observation in Effect Platform FileSystem; Cake domain code
  decides debounce/refresh and calls Git.
- Implement `WorktreeStorage` for Cake-owned Managed Worktree metadata.
- Move naming, create, land, abandon, status, rollback, and Project/Session
  coordination policy into free `managedWorktrees.ts` domain Effects.
- Replace worktree RPC operations and migrate the renderer Worktree Stores.
- Remove replaced `worktree-service`/handler paths.
- Preserve Git as authority for checkout facts and Cake as authority for
  managed metadata.

Test command cancellation, dirty/conflict states, failed persistence rollback,
concurrent land rejection, filesystem refresh policy, and the real Electron UI
path. Commit the slice and update Phase 9 progress.
```

## Packet 9B — VS Code Server

```text
Continue Phase 9 with the concrete VS Code Server vertical slice.

Read and follow the Common execution contract and VS Code ownership rules.

Scope:
- Implement one `VsCodeServer` Service, not a generic Editor abstraction.
- Own binary discovery/configuration, install/start/reuse, per-Working-
  Directory lifecycle, ports/tokens, health, source navigation, Source Control,
  and Cake review annotations as required by current behavior.
- Move Cake coordination policy to free domain Effects where multiple Services
  or business rules are involved.
- Replace VS Code RPC operations and migrate the owning renderer Store.
- Replace manual process registries with Effect-managed keyed scoped resources
  and finalizers; do not recreate those registries behind a Service.
- Remove superseded manager/handler paths.

Test reuse, concurrent acquire, failed startup, health loss, final release,
source navigation, Source Control focus, annotations, and the real Electron
boundary. Commit and update Phase 9 progress.
```

## Packet 9C — Session Terminals

```text
Continue Phase 9 with Terminal Service and Session Terminal domain behavior.

Read and follow the Common execution contract and Cake Session vocabulary.

Scope:
- Implement `Terminal` as the concrete PTY Service: create, input, resize,
  output Stream, exit, close, cancellation, and finalization.
- Implement free `sessionTerminals.ts` domain operations associating one or more
  Terminal handles with a Cake Session through stable IDs.
- Give the association an explicit Cake Session resource Scope independent of
  renderer visibility and transient Pi runtime consumers.
- Replace terminal RPC operations and migrate `TerminalStore`.
- Preserve or implement quake-style visibility as renderer application state;
  hiding never terminates the PTY.
- Remove superseded terminal manager/handler paths.

Test output ordering, resize/input, exit, explicit close, window detach,
Session-resource cleanup, process failure, and Electron UI behavior. Commit and
update Phase 9 progress.
```

## Packet 9D — Electron native capabilities

```text
Continue Phase 9 by migrating concrete Electron native capabilities behind
Effect Services and RPC.

Read and follow the Common execution contract and
`foundation-boundaries.md`.

Scope:
- Implement focused concrete `Electron` Service methods for Cake's existing
  windows, dialogs, external URLs, filesystem reveal, focus/fullscreen state,
  and application events.
- Allow renderer Stores to call simple native RPC capabilities directly;
  retain main domain RPC operations where Cake business policy coordinates
  multiple Services.
- Replace ad hoc request discriminants/preload methods for migrated operations.
- Keep preload transport-only and main authoritative for paths/trust.
- Scope window events and request cancellation correctly.
- Remove superseded handlers and renderer bridge calls.

Test native failures, cancellation, window closure, focus/fullscreen events,
and real Electron behavior. Commit and update Phase 9 progress.
```

## Packet 9E — Reviews and Artifacts

```text
Continue Phase 9 by migrating Reviews, Discussion anchors, Artifacts, and
structured requests vertically.

Read and follow the Common execution contract,
`s4-artifact-protocol.md`, storage architecture, and review/session contracts.

Scope:
- Implement focused ReviewStorage and ArtifactStorage Effect Services over the
  existing authorities and versioned formats.
- Move Cake review/artifact/request business logic to cohesive free domain
  Effects.
- Preserve Cake-owned anchors/artifact payloads and Pi-owned sidecar/transcript
  history.
- Replace RPC commands/queries/subscriptions and migrate owning renderer
  Stores/Models.
- Preserve bounds, content addressing, revisions, one-settlement request
  behavior, cancellation, sandboxing, Markdown fallbacks, and hydration.
- Remove replaced repositories/driver routing only after complete behavior is
  covered.

Run protocol, storage, sandbox, duplicate/late response, session replacement,
restart hydration, and focused Electron tests. Commit and update Phase 9
progress.
```

## Packet 9F — Cake Plugins and immutable recovery

```text
Complete Phase 9 by migrating Cake Plugin runtime, storage, build/activation,
backend process lifecycle, and immutable recovery to the Effect architecture.

Read and follow the Common execution contract, the complete
`cake-plugin-authoring` skill, `cake-plugins.md`, and storage/process boundaries.

Scope:
- Implement `PluginRuntime` and focused PluginStorage Effect Services around
  existing behavior.
- Move install/approve/enable/disable/build/activate/recover policy into free
  domain Effects.
- Replace plugin RPC operations and migrate renderer customization/plugin
  Stores without weakening trust boundaries.
- Preserve unrestricted backend authority in isolated utility processes,
  renderer import restrictions, optimistic revisions, exact-source builds,
  health-gated activation, diagnostics, last-known-good, and immutable recovery.
- Update the public plugin session API from legacy `workspacePath` to canonical
  `workingDirectory` in one greenfield change, including docs, authoring skill,
  public exports, fixtures, tests, and callers.
- Remove superseded plugin handlers/services after complete replacement.

Custom Renderer remains out of scope. Do not add source overlays, patch replay,
or semantic rebase machinery.

Run focused plugin integration and Electron recovery tests. Mark Phase 9
complete only when all remaining capabilities and its exit criteria pass.
Commit and identify final-removal inventory.
```

## Packet 10 — Final removal and enforcement

```text
Implement Phase 10, the final cleanup and architecture enforcement. Do not add
new product behavior.

Read and follow the Common execution contract and Phase 10 exit criteria in
`effect-migration.md`. Confirm Phases 0–9 are genuinely complete; if not, stop
and list the incomplete phase rather than hiding it in cleanup.

Inventory and remove:
- `r-state-tree`, all imports, and obsolete tests;
- legacy `src/models` after authoritative application data and all renderer
  projections have moved;
- the Promise `DesktopClient` facade;
- superseded Zod desktop IPC unions, preload request/event routes, and handlers;
- old main drivers, mutable registries, and adapters replaced by scoped Effect
  Services/domain operations;
- temporary migration facades, forwarding APIs, dead types, and stale docs.

Preserve Zod where it remains an intentional trusted plugin public API; do not
perform a global dependency purge without ownership evidence.

Add enforceable import/lint boundaries:
- renderer cannot import main, domain implementations, or privileged Services;
- IPC server delegates to domain;
- domain depends on Services;
- Services do not depend on domain;
- Pi packages exist only under `src/services/pi`;
- Electron/Node imports remain privileged-process-only.

Shrink `src/main/main.ts` to the minimal process entrypoint. Re-run source
inventories and reconcile every architecture document with actual code. Update
the migration handoff to completed status without deleting useful historical
phase evidence.

Run full formatting, lint, typecheck, unit tests, build, relevant integration
suites, and the complete set of affected Electron tests. Commit the final
cleanup and leave the worktree clean.

Custom Renderer remains unimplemented and outside scope after this phase.
```
