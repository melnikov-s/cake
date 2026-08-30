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

## Required external reference

The unpublished local package at `/Users/user/dev/effect-state-tree` is the
authority for effect-state-tree behavior during this migration. Before changing
renderer state, read its complete `README.md`, its
`skills/effect-state-tree/SKILL.md`, and every reference routed by that skill.
Its tests are the executable edge-case contract.

Cake and effect-state-tree use exactly the same Effect 4 version. At the time of
this handoff that version is `4.0.0-rc.111`. Cake uses
`effect/unstable/rpc` from that package; it does not install the Effect 3
`@effect/rpc` package.

The local effect-state-tree package deliberately remains unpublished. It has
explicit `.` and `./react` exports and declares Effect and React as peers.
Cake must provide the single Effect and React instances.

### Local dependency path caveat

From the main checkout `/Users/user/dev/cake`, the intended dependency is:

```json
{
  "effect": "4.0.0-rc.111",
  "effect-state-tree": "file:../effect-state-tree"
}
```

A Cake worktree under `/Users/user/dev/.cake-worktrees/<name>` has a different
relative path, so `file:../effect-state-tree` does not resolve there. Do not
commit a worktree-only relative path such as `file:../../effect-state-tree`.
During worktree development, arrange an uncommitted local symlink at the
expected sibling path or use a temporary absolute local override without
committing it. Before landing, verify that the committed dependency resolves
from the main checkout.
Do not use a configuration that installs a second Effect copy.

## Current implementation baseline

Verify these facts again before each phase; they describe the repository at the
creation of this handoff:

- Cake has no direct `effect` dependency and uses `r-state-tree@0.10.2`.
- Approximately 94 source files import `r-state-tree`.
- `src/models` contains 11 r-state-tree Models, including an authoritative
  main-process `Application` model mixed with renderer projection Models.
- `src/renderer/stores` contains 37 Store files.
- Approximately 30 renderer files consume the Promise-based `DesktopClient`.
- `src/renderer/desktop-client.ts` adapts the frozen `window.cake` bridge.
- `src/ipc` uses Zod contracts and `src/ipc/desktop-ipc.ts` contains a large
  request/event union.
- `src/preload/preload.ts` exposes `request` and `subscribe` over
  `cake:request` and `cake:event`.
- `src/main/main.ts` is over 2,300 lines and combines Electron lifecycle,
  mutable registries, IPC dispatch, and application coordination.
- `src/main/pi-workspace-driver.ts` is over 1,800 lines;
  `src/main/global-chat-driver.ts` separately implements Cake Chat runtime
  behavior.
- Pi packages are imported by focused `src/agent` modules, while main drivers
  consume those adapters.
- Storage is split among the `Application` r-state-tree Model and imperative
  repositories/services in `src/main`.
- Terminal infrastructure exists in `src/main/terminal-manager.ts` and
  `src/renderer/stores/TerminalStore.ts`, but the intended Session Terminal
  product remains incomplete.

Useful inventory commands:

```sh
rg -l 'r-state-tree' src
rg -l 'DesktopClient' src/renderer
rg -l '@earendil-works/pi-(coding-agent|ai)' src
find src/renderer/stores src/models src/ipc src/agent -type f | sort
wc -l src/main/*.ts | sort -n
```

Preserve behavior described by focused architecture contracts even when the
current implementation is awkward. The migration changes implementation and
ownership boundaries; it does not silently discard product behavior.

## Migration rules

1. **Work vertically.** A migrated capability includes Service, domain, RPC,
   renderer state where applicable, tests, and removal of its replaced path.
2. **Keep one authority.** Never persist Pi transcripts or create a second
   conversation engine while introducing Streams or Models.
3. **Use one protocol.** A temporary Promise facade may call the Effect RPC
   client, but it must not retain a separate Zod IPC contract for migrated
   operations.
4. **Use Effect all the way through main.** Do not wrap an Effect domain
   operation in a new Promise service abstraction.
5. **Keep the renderer sandboxed.** No migration shortcut may expose raw
   Electron IPC, Node, Pi, Git, filesystem, or main implementations.
6. **Translate concepts, not r-state-tree syntax.** Use effect-state-tree's
   factories, Refs, Scope, autoruns, child projections, and snapshot semantics.
7. **No permanent compatibility layer.** Remove transitional facades and old
   operations as soon as their migration slice has no callers.
8. **Name lifetimes and concurrency.** Every resource gets a Scope owner; every
   repeated async intent gets an explicit policy.
9. **Keep commits reviewable.** Do not combine an unrelated visual rewrite with
   a runtime migration.
10. **Update this handoff.** Mark phase progress, changed assumptions, and the
    next executable step after every landed migration slice.

## Target construction order

### Phase 0 — Baseline and dependency setup

Goal: make Effect 4 and effect-state-tree available without changing product
behavior.

Work:

- Add the exact Effect 4 dependency used by effect-state-tree.
- Add local effect-state-tree consumption with one Effect/React instance.
- Add Vite deduplication for `effect`, `react`, and `react-dom` if linked-module
  resolution demonstrates duplicate instances.
- Run effect-state-tree's own typecheck and tests against the local checkout.
- Record a focused baseline for Cake typecheck, unit tests, build, and Electron
  smoke tests relevant to the first slice.
- Add import-boundary lint rules only when their target directories exist.

Exit criteria:

- Cake imports Effect 4 and the effect-state-tree core/React entrypoints.
- The production build resolves one Effect and one React instance.
- No application behavior has changed.

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
- Implement a temporary Promise facade over the generated Effect RPC client so
  current `DesktopClient` consumers can migrate later.
- Do not maintain two schemas for a migrated operation.

Exit criteria:

- Electron UI tests prove decoding, typed failure, streaming, cancellation, and
  window-close cleanup.
- The temporary Promise facade uses Effect RPC internally.
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
- Migrate `ModelPresetSettingsStore` to effect-state-tree after the RPC path is
  working, or keep the temporary facade for this slice if main-first sequencing
  is intentionally being proven. Do not keep both Store implementations after
  the renderer portion lands.

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

### Phase 7 — Renderer effect-state-tree foundation

Goal: replace r-state-tree incrementally without duplicating renderer authority.

Create:

```text
src/renderer/RendererLive.ts
src/renderer/models/
src/renderer/stores/  # existing location, new factories
```

Work:

- Mount one root Store outside React with `CakeIpcClientLive` available.
- Move renderer projection Models from `src/models` to
  `src/renderer/models` as each slice migrates.
- Translate Model classes/decorators to `createModel` and Effect Schema.
- Translate Store classes to `createStore` and `Store.schema`.
- Acquire `CakeIpcClient` synchronously in Store initializers.
- Put subscriptions in `autorun` and bind them to Store Scope.
- Keep raw Store methods as lazy Effects and use the React facade only through
  `useStore`.
- Use immutable Ref updates and `batch` for logical projection transitions.
- Use projected child Stores only for keyed, state-selected behavioral
  children; compose always-present children directly.
- Keep Models inert and service-free.

Suggested renderer order:

1. settings and Model Presets;
2. Project and Session catalogs;
3. leaf chat configuration/composer Stores;
4. `ProjectSessionStore` and Cake Chat session Store;
5. registries and workbench;
6. root event routing and shell;
7. reviews, artifacts, plugins, and remaining surfaces.

Exit criteria per slice:

- one state owner and one Store implementation remain;
- current-first Stream subscription hydrates the correct Models;
- Store disposal interrupts subscriptions and operations;
- React uses `observer`, `StoreProvider`, and `useStore` correctly;
- focused Store and Electron tests pass.

### Phase 8 — Renderer snapshot persistence

Goal: persist only Cake-owned renderer application state through
Effect-state-tree snapshots.

Work:

- Mark persisted fields explicitly with `Store.snapshot`.
- Define the versioned `WindowStateSnapshot` document and migrations.
- Load and migrate before Store hydration.
- Apply the complete snapshot before Store autoruns activate.
- Start debounced `onSnapshot` persistence only after hydration.
- Preserve staged unsent chats, drafts, selection, panel state, and other
  explicitly Cake-owned values.
- Exclude Pi transcript projections, live operations, resources, Fibers,
  subscriptions, and terminal output.
- Verify applying a snapshot does not realize lazy child Stores.

Exit criteria:

- defaults never overwrite saved state during startup;
- malformed snapshots roll back or use the documented fallback;
- one batch produces one persistence emission;
- window reload and restart restore application state while transcript state is
  reconstructed from Pi.

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
4. migrate its renderer Store/Models;
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

- `r-state-tree` and all imports;
- `src/models` after all projection Models move and `Application` becomes
  stored/domain data;
- the Promise `DesktopClient` facade;
- superseded Zod IPC request/event unions and preload routes;
- manual runtime/subscription maps replaced by scoped resources;
- obsolete main drivers and handlers;
- compatibility forwarding APIs introduced only for this migration.

Do not remove Zod merely because Effect Schema owns Cake's internal RPC and
storage boundaries. The trusted plugin public API currently uses Zod as an
explicit user-facing dependency; changing that contract is a separate product
decision.

Add lint/import boundaries enforcing:

```text
renderer → CakeIpcClient, never main/services/domain implementations
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
real domain operations with Test Layers. Store tests use a controlled
`CakeIpcClient` Layer and Streams. Electron tests prove the real boundary.

## Handoff protocol for each agent

At the start of a migration task:

1. read `AGENTS.md` and all architecture documents relevant to the slice;
2. read this document's current progress notes;
3. verify repository and local effect-state-tree state rather than assuming the
   inventory remains current;
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

| Phase                     | Status      | Notes / next executable step                                                                |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| 0. Dependencies           | Not started | Add Effect 4 and local effect-state-tree with worktree-safe local resolution.               |
| 1. Main runtime           | Not started | Create `MainLive`, `MainApplication`, and shutdown Scope.                                   |
| 2. Effect RPC             | Not started | Implement Electron RPC Protocol adapters and prove query/error/stream/cancel.               |
| 3. Typed storage          | Not started | Extract authoritative `Application` state from r-state-tree.                                |
| 4. Model Presets slice    | Not started | First complete capability after storage and RPC foundation.                                 |
| 5. Pi Services            | Not started | Consolidate Pi imports under `src/services/pi`.                                             |
| 6. Cake Session domain    | Not started | Unify Project/Cake Chat/Discussion/Subagent behavior above `PiSessions`.                    |
| 7. Renderer state tree    | Not started | Start with settings/Model Presets, then catalogs and session Stores.                        |
| 8. Renderer persistence   | Not started | Version and hydrate effect-state-tree window snapshots.                                     |
| 9. Remaining capabilities | Not started | Migrate Git/worktrees, VS Code, terminal, Electron, reviews, artifacts, plugins vertically. |
| 10. Final removal         | Not started | Remove legacy state tree, DesktopClient, old IPC, drivers, and transitional APIs.           |
