# Effect architecture migration handoff

This is the implementation handoff from Cake's current architecture to the
normative target in:

1. [`../architecture/cake-architecture.md`](../architecture/cake-architecture.md)
2. [`../architecture/cake-vocabulary.md`](../architecture/cake-vocabulary.md)
3. [`../architecture/effect-architecture.md`](../architecture/effect-architecture.md)
4. [`../architecture/cake-storage.md`](../architecture/cake-storage.md)
5. [`../architecture/cake-plugins.md`](../architecture/cake-plugins.md)

The separately documented
[`cake-custom-renderer.md`](../architecture/cake-custom-renderer.md) is a future,
unimplemented product design. It is explicitly out of scope for this migration
and is not required reading unless a change could accidentally weaken its future
security boundary.

This document is temporary and current-state-aware. Architecture documents say
what Cake is; this document says how the repository becomes it. Copyable,
bounded work-packet prompts are in
[`effect-migration-prompts.md`](./effect-migration-prompts.md). Do not preserve
a transitional API merely because it appears here.

## Required Effect references

Before writing or reviewing Effect code, read Cake's complete
`.agents/skills/effect-ts/SKILL.md`, every branch reference it routes to, and
the installed `node_modules/effect/AGENTS.md`. Cake's architecture remains the
authority for ownership and process boundaries, while the installed package is
the API authority and the local skill defines implementation conventions.

Before changing renderer Models, Stores, snapshots, or lifecycle, read the
installed `node_modules/r-state-tree/README.md`,
`node_modules/r-state-tree/skills/r-state-tree/SKILL.md`, and every reference it
routes to.

Cake keeps `r-state-tree@0.10.2` as the renderer state system. Effect remains
the main/domain/RPC runtime and is also used privately by renderer
infrastructure. Ordinary renderer Models and Stores do not import Effect.

The renderer has one window-local Effect runtime behind a permanent typed
Promise `RendererClient`. One window-owned Model synchronizer consumes Effect
RPC Streams, maps Updates to snapshots, and applies them to r-state-tree Models.
This adapter is an
intentional architecture boundary, not a temporary compatibility facade.

## Current implementation baseline

Verify these facts again before each phase; the migration is active and the
repository changes vertically:

- Effect 4 and Effect RPC are established in main and renderer infrastructure.
- Main-owned application state and Model Presets use typed Effect storage and
  domain operations.
- `PiSessions`, `PiModels`, and `PiAgentResources` form the target Pi boundary.
- Project Sessions, Cake Chat Sessions, Discussion Sessions, and Subagents have
  Effect domain/RPC paths, while focused legacy renderer adapters remain.
- The renderer remains r-state-tree. The permanent `RendererClient` owns every
  migrated Effect command; `DesktopClient` now contains only capabilities awaiting
  later privileged-capability passes.
- One window-owned Model synchronizer is the only renderer Effect Stream consumer.
  `RootStore` supplies loaded Models; feature Stores do not access it.
- `src/main/main.ts` and `src/main/pi-workspace-driver.ts` still contain legacy
  capability paths that later vertical slices must remove.

Useful inventory commands:

```sh
rg -l 'r-state-tree' src/renderer src/models
rg -l 'DesktopClient' src/renderer
rg -l 'CakeIpcClient|effect/unstable/rpc' src/renderer src/ipc
rg -l '@earendil-works/pi-(coding-agent|ai)' src
find src/renderer/stores src/renderer/models src/models src/ipc src/services/pi -type f | sort
```

Preserve behavior described by focused architecture contracts even when the
current implementation is awkward. The migration changes implementation and
ownership boundaries; it does not silently discard product behavior.

## Migration rules

1. **Optimize for the final architecture, not intermediate executability.** Work
   in broad dependency-ordered passes. The application may fail to typecheck,
   build, or run between internal checkpoints; do not add adapters merely to
   keep an intermediate state runnable.
2. **Keep one authority.** Never persist Pi transcripts or create a second
   conversation engine while introducing Streams or Models.
3. **Use one protocol.** The permanent Promise `RendererClient` executes the
   generated Effect RPC client; it must not retain a separate Zod IPC contract.
4. **Use Effect all the way through main.** Do not wrap an Effect domain
   operation in a new Promise service abstraction.
5. **Keep the renderer sandboxed.** No migration shortcut may expose raw
   Electron IPC, Node, Pi, Git, filesystem, or main implementations.
6. **Keep renderer Effect mechanics isolated.** Ordinary r-state-tree Models and
   Stores never import Effect, Layers, Fibers, Streams, or RPC envelopes.
   `RendererClient` adapts commands; the Model synchronizer adapts Streams and is
   supplied loaded Models only by `RootStore`.
7. **Avoid transitional compatibility work.** Change all callers in one bulk
   pass and delete the old path once. Introduce an adapter only when it is part
   of the final architecture.
8. **Name lifetimes and concurrency.** Every resource gets a Scope owner; every
   repeated async intent gets an explicit policy.
9. **Minimize repeated work.** Inventory once per bulk pass, group mechanical
   edits, defer broad formatting/verification to the checkpoint, and avoid
   reopening the same files in many packets.
10. **Use coarse checkpoints.** Savepoint commits may be broken. Update this
    handoff and run broad verification once per completed bulk pass or concrete
    blocker.

## Target construction order

### Phase 0 — Baseline and Effect dependency setup

Goal: make the pinned Effect 4 runtime available without changing renderer
state management.

Work:

- Add the exact Effect 4 dependency used by Cake's RPC and main runtime.
- Verify the production build resolves one Effect instance.
- Record a focused baseline for typecheck, tests, build, and Electron RPC smoke
  coverage.
- Keep `r-state-tree` as the renderer state dependency.

Exit criteria:

- Cake imports the pinned Effect 4 release.
- Existing renderer behavior is unchanged.

### Phase 1 — Main Effect runtime

Goal: establish Effect as main's execution and lifetime model.

Create:

```text
src/main/MainLive.ts
src/main/MainApplication.ts
src/main/BootstrapLive.ts
```

Work:

- Create one main `ManagedRuntime` from `MainLive`.
- Wrap Electron application startup and shutdown in `MainApplication`.
- Provide Effect Platform filesystem, path, HTTP, and process services needed by
  later adapters.
- Keep `src/main/main.ts` as the temporary imperative boundary, then shrink it
  as handlers move.
- Establish logging, tracing annotations, and top-level defect reporting.
- Do not move all existing main modules at once.

Exit criteria:

- Main starts and stops through the ManagedRuntime.
- Scope closure is wired to Electron shutdown.
- Existing behavior and IPC continue to work.
- `main.ts` delegates lifecycle rather than creating a second runtime.

### Phase 2 — Effect RPC over Electron

Goal: make Effect RPC the sole target protocol while preserving the existing
renderer temporarily.

Create the target structure:

```text
src/ipc/protocol/
src/ipc/client/
src/ipc/server/
src/ipc/transport/
```

Work:

- Define RPC groups with `effect/unstable/rpc` and Effect Schemas.
- Implement the renderer and server Electron Protocol adapters.
- Carry connection identity and tracing metadata through RPC middleware.
- Prove a query, typed failure, streaming RPC, and interrupted long-running
  request through the real Electron boundary.
- Scope requests/subscriptions to the renderer connection.
- Keep preload narrow and transport-only.
- Establish the permanent typed Promise renderer adapter over the generated
  Effect RPC client. It may initially live inside `DesktopClient`, but the
  target surface is the focused semantic `RendererClient`.
- Do not maintain two schemas for a migrated operation.

Exit criteria:

- Electron UI tests prove decoding, typed failure, streaming, cancellation, and
  window-close cleanup.
- The Promise renderer adapter uses Effect RPC internally and owns one
  window-local runtime.
- At least one old `desktop-ipc` operation is removed end-to-end.

### Phase 3 — Typed file storage and application state

Goal: remove persistence authority from the r-state-tree `Application` Model and
establish versioned focused storage Services.

Create Services such as:

```text
ApplicationStorage
WindowStateStorage
WorktreeStorage
ReviewStorage
ArtifactStorage
PluginStorage
```

Work:

- Implement version envelopes, sequential migrations, Effect Schema decoding,
  atomic temporary-write/rename, and typed failures.
- Reuse internal file helpers without exposing a generic untyped storage API to
  domain modules.
- Convert `src/models/Application.ts` into ordinary stored/domain Schema values
  and domain operations. It does not move to `src/renderer/models`.
- Preserve Pi storage roots and transcript authority exactly.
- Expose storage through RPC only where renderer ownership requires it.
- Keep credentials outside Cake documents.

Exit criteria:

- Application state loads, migrates, validates, and saves through an Effect
  Service.
- No main-owned state depends on an r-state-tree Model.
- Corrupt and older documents have deterministic tested outcomes.
- Writes are atomic and interruption-safe at the chosen boundary.

### Phase 4 — First vertical slice: Models and Model Presets

Goal: exercise Services, domain operations, storage, Effect RPC, and renderer
integration on a bounded feature.

Services:

- `PiModels` for catalog, authentication/availability, resolution, and bounded
  completion;
- `ApplicationStorage` or focused preset storage for Cake-owned presets.

Domain:

```text
src/domain/modelPresets.ts
```

RPC group:

```text
modelPresets.list
modelPresets.create
modelPresets.update
modelPresets.remove
modelPresets.resolve
modelPresets.observe, only if there is a real independent change source
```

Work:

- Preserve unresolved presets and report typed resolution failures.
- Use `thinkingLevel` consistently in new contracts.
- Replace the old preset operations in `DesktopClient` and main dispatch.
- Keep `ModelPresetSettingsStore` in r-state-tree. It invokes semantic Promise
  operations on the renderer client and never imports Effect or RPC definitions.

Exit criteria:

- Presets operate end-to-end through Effect RPC and typed storage.
- Pi model identities remain Pi-owned; preset names/preferences remain
  Cake-owned.
- The old preset IPC contract and main handler are removed.
- Focused renderer and Electron tests pass.

### Phase 5 — Complete the Pi Service boundary

Goal: replace focused adapter fragments plus driver-owned Pi lifecycle with the
three agreed Services.

Create:

```text
src/services/pi/PiSessions.ts
src/services/pi/PiModels.ts
src/services/pi/PiAgentResources.ts
src/services/pi/live/...
```

Map current code deliberately:

- session discovery, projection, handoff, sidecars, isolated sessions, and
  runtime construction feed `PiSessions`;
- `model-catalog.ts`, utility-model execution, and model resolution feed
  `PiModels`;
- resource loading and compatibility diagnostics feed `PiAgentResources`;
- response retry and turn recovery remain explicit Pi adapter policies;
- extension UI adaptation stays session-bound;
- pure Pi-to-Cake mapping remains ordinary modules.

Work:

- Ensure only `src/services/pi` imports Pi packages after the phase.
- Implement keyed scoped acquisition for live Pi Session Runtimes.
- Define semantic capability profiles for every Cake Session kind.
- Return an initial authoritative snapshot followed by live events through Pi
  APIs; never tail JSONL directly.
- Keep extension execution in the acquired session runtime.
- Keep utility completion stateless and transcript-free.

Exit criteria:

- `rg` finds Pi package imports only beneath `src/services/pi`.
- Runtime sharing and final release are tested.
- Pi JSONL reopen, extension binding, commands, UI compatibility, retries,
  cancellation, and event projection retain focused contract coverage.
- There is no `PiExtensions` service and no generic second LLM abstraction.

### Phase 6 — Cake Session domain and streaming RPC

Goal: replace parallel driver policy with shared Cake Session domain operations
above `PiSessions`.

Create cohesive domain modules:

```text
conversations.ts
projectSessions.ts
cakeChats.ts
discussionSessions.ts
subagents.ts
```

Work:

- Centralize shared Cake Session acquisition, capability-profile selection, and
  Pi-to-Cake update projection in free domain functions.
- Preserve distinct kind policy without creating distinct conversation engines.
- Migrate Project Session and Cake Chat commands/queries/subscriptions to RPC.
- Define stable Subagent handles; `spawn`, `wait`, activity, steer, abort, and
  completion all refer to the same handle. Polling never creates another
  logical activity record.
- Preserve review/message anchors as Cake facts and sidecar replies as Pi facts.
- Return accepted turn IDs/handles from commands and stream lifecycle updates.

Exit criteria:

- Project Session, Cake Chat Session, Discussion Session, and Subagent Session
  all use the same `PiSessions` runtime boundary.
- Renderer protocol carries Cake-owned snapshots/events, not raw Pi values.
- Reconnect obtains a fresh Pi-authoritative snapshot without a Cake transcript
  log.
- Existing `PiWorkspaceDriver` and `GlobalChatDriver` responsibilities have
  moved or are explicitly reduced to temporary adapters with named removal
  tasks.

## Remaining migration strategy

Phases 0–6 were implemented as runnable vertical slices. Remaining work uses
four broad passes optimized for implementation speed, context reuse, and token
efficiency. **A runnable application is not required between internal steps or
savepoint commits.** Do not preserve temporary callers, duplicate protocols,
dual state owners, or intermediate fixtures.

Each pass gets one inventory and one cleanup/verification checkpoint. Work in
dependency order and tolerate temporary compile failures.

### Bulk Pass A — Final renderer boundary

Establish the complete final renderer infrastructure before adapting feature
state:

- create one window-owned `RendererRuntime` and final typed Promise
  `RendererClient` grouped by semantic capability;
- move every Effect command adapter out of `DesktopClient`, including
  `AbortSignal` → Fiber/RPC interruption and stable renderer-facing failures;
- create one small window-owned Model synchronizer that subscribes to current-first
  Streams, maps Updates to snapshots, applies them with `applySnapshot`, filters
  stale revisions/generations, reconnects from Snapshots, and cleans up;
- define final Store/client injection; only `RootStore` supplies loaded Models to
  the synchronizer, and feature Stores never access synchronization machinery;
- update all renderer call sites mechanically to the final client surface;
- remove replaced Promise-client APIs, raw bridge calls for migrated
  capabilities, and temporary runtime helpers in one sweep.

Do not keep `DesktopClient` methods merely to preserve compilation during the
caller sweep.

Checkpoint once after the full sweep: formatter, Oxlint, typecheck, focused
client/runtime tests, and Effect RPC Electron smoke coverage.

### Bulk Pass B — All renderer state and persistence

Convert the entire renderer projection/state layer together:

1. move/create all r-state-tree projection Models in their final ownership
   layout;
2. implement Project and Session catalogs, loaded Project Sessions, Cake Chats,
   Discussions, Subagents, reviews, artifacts, extension UI, and all other
   observations through the single Bulk Pass A Model synchronizer;
3. update all Stores to read stable Models and call `RendererClient` commands;
4. remove broad `DesktopClientEvent` translation, root projection routing,
   per-Store authoritative subscriptions, and duplicate state;
5. implement versioned r-state-tree hydration/persistence after the final Store
   tree is known;
6. delete superseded renderer helpers, tests, events, and facades in one sweep.

Preserve stable Model identity, Snapshot/Event ordering, one observation per
loaded identity, stale-generation rejection, and one r-state-tree transaction
per logical Update. Persist only Cake-owned window state.

Checkpoint once: formatter, lint, typecheck, renderer unit/projection tests,
build, and affected chat/sidebar Electron tests.

### Bulk Pass C — All remaining privileged capabilities

Migrate together in this internal order:

1. Electron-native and Effect Platform filesystem capabilities;
2. Git, Managed Worktrees, and typed storage;
3. VS Code Server and Terminal lifecycles;
4. reviews, artifacts, and Discussion integration;
5. plugin runtime, storage, activation, and recovery.

Across the pass, define final Services, move Cake policy to free domain Effects,
add final RPC groups, wire the already-final renderer infrastructure, update all
callers, then delete old Zod desktop operations, imperative handlers, drivers,
registries, and superseded tests together.

Do not finish or verify each capability as a separately runnable slice. Use
focused checks only to diagnose an uncertain boundary.

Checkpoint once: formatter, full lint/typecheck/unit tests, targeted integration
tests, build, and affected Electron tests.

## Explicitly out of scope: Custom Renderer

Do not implement the future Custom Renderer capability as part of this
migration. The Effect architecture should preserve a narrow RPC security
boundary that would make the feature safe later, but migration work must not
add patch replay, source overlays, semantic rebasing, Custom Renderer authoring,
or Custom Renderer activation machinery. Those require a separate future
project and acceptance plan.

### Bulk Pass D — Final cleanup, enforcement, and release verification

Remove all migration scaffolding in one sweep: broad `DesktopClient` and
`DesktopClientEvent`, superseded desktop unions/routes, obsolete main drivers,
handlers and resource maps, forwarding APIs, unused schemas/fixtures/helpers,
and stale terminology.

Keep r-state-tree, one renderer Effect runtime, Effect RPC/generated
`CakeIpcClient`, permanent Promise `RendererClient`, and the one window-owned
Model synchronizer.
Add final import boundaries and run the full release matrix once. Fix failures
against the final architecture; never restore compatibility paths.

## Verification policy

Verification is checkpoint-based, not per edit. During Bulk Passes A–C, run only
the cheapest command needed for the next implementation decision. Temporary
type, lint, test, and build failures are acceptable and must not be hidden by
compatibility code.

At each completed pass checkpoint run:

```sh
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Then run only integration/Electron tests affected by that pass. Bulk Pass D runs
the full release matrix. Write tests while implementation context is fresh, but
batch execution. Run a focused test early only to resolve uncertainty about a
real boundary, lifecycle, concurrency law, or defect.

Use Effect `TestClock` for time policy. Domain tests use real operations with
Test Layers. Store tests inject `RendererClient`; projection tests use
controlled Streams; Electron tests prove the process boundary.

## Bulk-pass handoff protocol

Prefer one long-lived session per bulk pass. Read required guidance once,
inventory the whole pass once, and record the final dependency/file shape before
editing. Do not update progress or produce handoffs for internal substeps.
Savepoint commits may be broken and exist only for recovery.

At pass completion—or a concrete blocker—record only:

1. final architecture completed;
2. old paths removed;
3. unresolved failures with evidence;
4. exact next dependency boundary;
5. checkpoint results.

Retain a concise pass-local working note through compaction instead of rereading
every document or rerunning inventory.

## Progress table

| Work                                  | Status      | Notes / next executable step                                                                                                                                                                  |
| ------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phases 0–6                            | Complete    | Effect dependency, main runtime, RPC, typed storage, Model Presets, Pi Services, and Cake Session domain are established.                                                                     |
| Bulk Pass A — renderer boundary       | Complete    | One window runtime, semantic `RendererClient`, Store Context injection, and the Root-only Model synchronizer are established; replaced Effect adapters and migrated event routes are removed. |
| Bulk Pass B — renderer state          | Not started | Convert every authoritative projection and Store dependency together, then implement final r-state-tree hydration/persistence and remove broad event routing.                                 |
| Bulk Pass C — privileged capabilities | Not started | Migrate all remaining native/product Services, domain operations, RPC, renderer wiring, and legacy driver/handler removal as one broad pass.                                                  |
| Bulk Pass D — final enforcement       | Not started | Remove migration scaffolding, add import boundaries, update final docs, and run the release verification matrix once.                                                                         |
