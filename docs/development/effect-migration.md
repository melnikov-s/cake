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
Promise `RendererClient`. Focused projection synchronizers consume Effect RPC
Streams and reduce Updates into r-state-tree Models. This adapter is an
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
- The renderer remains r-state-tree. `DesktopClient` is still broad migration
  debt and must become the focused permanent `RendererClient`.
- Renderer projection synchronization is not yet consistently separated from
  Stores and the broad desktop event adapter.
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

1. **Work vertically.** A migrated capability includes Service, domain, RPC,
   renderer state where applicable, tests, and removal of its replaced path.
2. **Keep one authority.** Never persist Pi transcripts or create a second
   conversation engine while introducing Streams or Models.
3. **Use one protocol.** The permanent Promise `RendererClient` executes the
   generated Effect RPC client; it must not retain a separate Zod IPC contract
   for migrated operations.
4. **Use Effect all the way through main.** Do not wrap an Effect domain
   operation in a new Promise service abstraction.
5. **Keep the renderer sandboxed.** No migration shortcut may expose raw
   Electron IPC, Node, Pi, Git, filesystem, or main implementations.
6. **Keep renderer Effect mechanics isolated.** Ordinary r-state-tree Models and
   Stores never import Effect, Layers, Fibers, Streams, or RPC envelopes.
   `RendererClient` adapts commands; projection synchronizers adapt Streams.
7. **No permanent compatibility layer.** Remove transitional facades and old
   operations as soon as their migration slice has no callers.
8. **Name lifetimes and concurrency.** Every resource gets a Scope owner; every
   repeated async intent gets an explicit policy.
9. **Keep commits reviewable.** Do not combine an unrelated visual rewrite with
   a runtime migration.
10. **Update this handoff.** Mark phase progress, changed assumptions, and the
    next executable step after every landed migration slice.

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

### Phase 7 — Renderer client and projection architecture

Goal: retain r-state-tree as the renderer state system while removing Effect and
transport mechanics from ordinary Models and Stores.

Create the target structure as vertical slices require it:

```text
src/renderer/RendererRuntime.ts
src/renderer/client/
  RendererClient.ts
  RendererClientLive.ts
src/renderer/projections/
src/renderer/models/
src/renderer/stores/
```

Renderer runtime and client work:

- Own one `ManagedRuntime` for the renderer window and dispose it on teardown.
- Make `RendererClient` a permanent typed Promise API grouped by semantic Cake
  capability. It privately executes `CakeIpcClient` Effects.
- Accept `AbortSignal` for cancellable commands and map it to Fiber/RPC
  interruption.
- Expose stable renderer-facing discriminated failures; do not leak transport
  envelopes or arbitrary rejected values.
- Replace the broad `DesktopClient` incrementally; do not preserve duplicate
  operation names or protocols.

Projection work:

- Add focused projection synchronizers/registries for Project catalogs, Session
  catalogs, loaded Project Sessions, Cake Chat Sessions, discussions, and other
  independently observed authorities.
- Consume current-first Effect RPC Streams only in projection infrastructure.
- Own one observation per loaded identity, with an explicit window/registry/entity
  lifetime.
- Apply Snapshot then ordered Events, filter stale revisions and generations,
  reconnect from a fresh Snapshot, and commit each logical Update in one
  r-state-tree transaction.
- Preserve stable Model identity across views and reconnects.
- Never let arbitrary Fibers retain and mutate Stores or Models directly; enter
  projection state through one synchronous reducer boundary.

Store and Model work:

- Keep r-state-tree Models as inert reactive projections and synchronous
  invariants.
- Keep r-state-tree Stores as focused owners of window-local application/UI
  state, workflow policy, and semantic intents.
- Stores read projection Models and invoke `RendererClient`; they do not import
  Effect, `CakeIpcClient`, Streams, Layers, Fibers, or RPC contracts.
- Store disposal aborts its cancellable operations and prevents stale local
  commits. Every repeated intent still declares queue/reject/latest-wins/share/
  independent policy.
- Moving Models from `src/models` to `src/renderer/models` is an ownership move,
  not a state-framework conversion.

Suggested order:

1. extract the permanent `RendererClient` from the broad desktop facade;
2. Model Preset Promise commands;
3. Project and Project Session catalog synchronizers;
4. keyed Project Session and Cake Chat projection registries;
5. discussions, Subagents, reviews, artifacts, and extension UI;
6. remove broad desktop events and remaining raw bridge calls per capability.

Exit criteria per slice:

- one projection authority and one Store implementation remain;
- ordinary Stores/Models contain no Effect imports;
- stream lifetime, revision, reconnect, identity, and cancellation behavior are
  tested;
- the replaced legacy desktop request/event operations are deleted;
- focused Store, projection, and Electron tests pass.

### Phase 8 — Renderer snapshot persistence

Goal: persist only Cake-owned r-state-tree application state.

Work:

- Mark persisted r-state-tree fields explicitly.
- Define the versioned `WindowStateSnapshot` document and migrations.
- Load, migrate, and validate before mounting the root with its snapshot or
  before activating ordinary Store effects.
- Start debounced snapshot persistence through `RendererClient` only after
  successful hydration.
- Preserve staged unsent chats, drafts, selection, panel state, and other
  explicitly Cake-owned values.
- Exclude Pi transcript projections, authoritative catalog/session Models, live
  operations, resources, subscriptions, timers, handles, and terminal output.

Exit criteria:

- defaults never overwrite saved state during startup;
- malformed snapshots have a documented tested fallback;
- one logical transaction produces one persistence update;
- reload restores renderer application state while authoritative projections are
  reconstructed from Streams.

### Phase 9 — Remaining native and product capabilities

Migrate vertically rather than by directory:

- `Git` plus `managedWorktrees.ts` and `WorktreeStorage`;
- Effect Platform filesystem observation plus Cake refresh policy;
- concrete `VsCodeServer` lifecycle and commands;
- `Terminal` plus `sessionTerminals.ts` and renderer quake-console state;
- `Electron` RPC capabilities;
- reviews and artifacts;
- `PluginRuntime`, plugin storage, activation, and recovery. When the plugin
  session API moves from legacy `workspacePath` to `workingDirectory`, update
  `cake-plugins.md`, the `cake-plugin-authoring` skill, public exports, fixtures,
  and every plugin caller in the same slice.

For each capability:

1. define the outside-world Service;
2. move Cake policy to free domain Effects;
3. add/replace its RPC group;
4. add/update `RendererClient` operations and projection synchronizers, then
   update the owning r-state-tree Store/Models;
5. delete the replaced implementation and protocol operations;
6. run focused verification.

## Explicitly out of scope: Custom Renderer

Do not implement the future Custom Renderer capability as part of this
migration. The Effect architecture should preserve a narrow RPC security
boundary that would make the feature safe later, but migration work must not
add patch replay, source overlays, semantic rebasing, Custom Renderer authoring,
or Custom Renderer activation machinery. Those require a separate future
project and acceptance plan.

### Phase 10 — Final removal and enforcement

Remove:

- the broad legacy `DesktopClient` after focused `RendererClient` capabilities
  replace it;
- superseded Zod IPC request/event unions and preload routes;
- direct Effect/`CakeIpcClient` usage from ordinary renderer Stores and Models;
- manual runtime/subscription maps replaced by scoped Effect resources or
  focused projection registries;
- obsolete main drivers and handlers;
- compatibility forwarding APIs introduced only for migration.

Keep:

- `r-state-tree` for renderer Models, Stores, snapshots, and React integration;
- one internal renderer Effect runtime;
- Effect RPC and generated `CakeIpcClient`;
- the permanent typed Promise `RendererClient`;
- focused projection synchronization infrastructure.

Do not remove Zod merely because Effect Schema owns Cake's internal RPC and
storage boundaries. The trusted plugin public API currently uses Zod as an
explicit user-facing dependency; changing that contract is separate.

Add lint/import boundaries enforcing:

```text
renderer components → Stores/Models only
renderer Stores → RendererClient, never Effect/CakeIpcClient/RPC/main/domain
renderer projections → CakeIpcClient + renderer Models
IPC server → domain
domain → Services
Services ↛ domain
Pi packages → src/services/pi only
Electron and Node → privileged process modules only
```

Exit criteria:

- all architecture documents describe the implementation without transitional
  exceptions;
- current source contains no obsolete architecture;
- `src/main/main.ts` is a minimal entrypoint;
- full typecheck, lint, unit tests, build, targeted integration tests, and
  affected Electron tests pass.

## Verification policy

For every source change:

```sh
pnpm format
pnpm format:check
pnpm lint:oxlint
pnpm typecheck
pnpm test
```

Run focused integration and Electron tests for the changed boundary. Build
before interpreting Electron smoke results because smoke tests execute `out/`.
Do not use jsdom or a browser-only page as proof of Electron IPC, focus,
selection, portals, typing, or native lifecycle behavior.

Important focused acceptance areas during migration:

- RPC query, typed error, Stream, interruption, and window cleanup;
- Pi JSONL reopen and complete active-branch projection;
- Pi Extension binding and supported/degraded UI methods;
- project trust before resource loading;
- Store hydration before autorun and persistence;
- Store/child Scope disposal and stale-result rejection;
- normal Project Session chat input and slash-command handling;
- Cake Chat and Discussion Session use of shared Chat;
- Subagent handle/activity deduplication;
- plugin build, activation, backend lifecycle, and immutable recovery;
- VS Code focus/annotations and terminal process cleanup.

Use Effect `TestClock` for retry, debounce, and timer policy. Domain tests use
real domain operations with Test Layers. Store tests use a controlled Promise `RendererClient`. Projection tests use
controlled Streams. Electron tests prove the real boundary.

## Handoff protocol for each agent

At the start of a migration task:

1. read `AGENTS.md` and all architecture documents relevant to the slice;
2. read this document's current progress notes;
3. verify repository state and the installed r-state-tree API rather than
   assuming the inventory remains current;
4. name the authority, owner, lifetime, persistence boundary, and concurrency
   policy of every state/resource being changed;
5. identify exactly which old path will be removed by the slice.

At the end:

1. remove temporary code no longer needed by the slice;
2. run proportionate verification;
3. update focused architecture contracts if the accepted product contract
   changed;
4. update the progress table below;
5. record the next concrete entry point and any blocker;
6. do not rewrite the normative architecture to justify an accidental
   implementation shortcut.

## Progress table

| Phase                          | Status                   | Notes / next executable step                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Effect conventions gate        | Complete through Phase 6 | Main/domain/RPC paths use named Effects, Schema boundaries, explicit Scope ownership, and deterministic Stream/concurrency primitives.                                                                                                                             |
| 0. Dependencies                | Complete                 | Effect `4.0.0-rc.111` is pinned. r-state-tree remains the renderer state system; effect-state-tree was removed.                                                                                                                                                    |
| 1. Main runtime                | Complete                 | One `ManagedRuntime` owns scoped Electron lifecycle and shutdown.                                                                                                                                                                                                  |
| 2. Effect RPC                  | Complete                 | Effect RPC crosses sandboxed renderer/preload/main with Schema validation, typed failures, Streams, interruption, and connection cleanup. The Promise adapter is now a permanent renderer boundary, though its broad `DesktopClient` shape still needs extraction. |
| 3. Typed storage               | Complete                 | Main-owned application state uses focused Effect storage and no main r-state-tree authority.                                                                                                                                                                       |
| 4. Model Presets               | Complete                 | Domain/storage/RPC are Effect-native; `ModelPresetSettingsStore` remains r-state-tree and calls the Promise adapter.                                                                                                                                               |
| 5. Pi Services                 | Complete                 | `PiSessions`, `PiModels`, and `PiAgentResources` own the Pi boundary and scoped runtimes.                                                                                                                                                                          |
| 6. Cake Session domain         | Complete                 | Project, Cake Chat, Discussion, and Subagent domain/RPC paths share `PiSessions`; current Subagent completion is preserved.                                                                                                                                        |
| 7. Renderer client/projections | Not started              | Prior effect-state-tree Packets 7A, 7B, and partial 7C were removed. Next: extract focused `RendererClient`, then implement r-state-tree catalog projection synchronizers without changing renderer state framework.                                               |
| 8. Renderer persistence        | Not started              | Version and hydrate explicit r-state-tree window snapshots.                                                                                                                                                                                                        |
| 9. Remaining capabilities      | Not started              | Migrate Git/worktrees, VS Code, terminal, Electron, reviews, artifacts, and plugins vertically through Services/domain/RPC/client/projections.                                                                                                                     |
| 10. Final removal              | Not started              | Remove broad DesktopClient, old IPC/drivers, and transitional adapters; keep r-state-tree plus renderer infrastructure Effect runtime.                                                                                                                             |
