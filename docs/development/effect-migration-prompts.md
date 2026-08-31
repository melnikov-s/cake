# Effect migration work packets

These prompts implement [`effect-migration.md`](./effect-migration.md). Read
`AGENTS.md`, the normative architecture documents, the migration handoff, Cake's
Effect skill, and the installed Effect guide before changing Effect code.

## Common execution contract

For every packet:

1. Verify current source and tests; do not assume the handoff inventory is exact.
2. Name authority, owner, lifetime, persistence boundary, and repeated-call
   concurrency policy for every changed state/resource.
3. Work vertically through Service/domain/RPC/renderer integration and delete the
   replaced path in the same slice.
4. Keep one Effect RPC protocol. Never introduce a second renderer wire schema.
5. Keep the renderer sandboxed.
6. Preserve Pi as transcript/model authority.
7. Keep ordinary r-state-tree Stores and Models free of Effect, Layers, Fibers,
   Streams, `CakeIpcClient`, and RPC envelopes.
8. Use the permanent Promise `RendererClient` for Store commands and focused
   projection synchronizers for authoritative Streams.
9. Run focused tests, typecheck, Oxlint, formatting, build, and affected Electron
   coverage in proportion to the change.
10. Update the progress table and next executable step.

## Packet 0 — Effect dependency

Pin Cake's exact Effect 4 release, verify one production Effect instance, retain
`r-state-tree`, and record the baseline. Do not add effect-state-tree or change
renderer behavior.

## Packet 1 — Main runtime

Establish one main `ManagedRuntime`, `MainLive`, `MainApplication`, and minimal
bootstrap/shutdown wiring. Move no unrelated capabilities.

## Packet 2 — Effect RPC over Electron

Implement shared Effect RPC groups/Schemas, the narrow preload transport, server
handlers, connection Scopes, typed failure, streaming, interruption, and window
cleanup. Add the permanent typed Promise renderer adapter over the generated
client. It is an architecture boundary, not a temporary compatibility facade.

## Packet 3 — Typed application storage

Replace main-owned r-state-tree application authority with focused Effect Schema
storage, version migrations, atomic writes, typed failures, and free domain
operations. Keep renderer Models out of main.

## Packet 4 — Model Presets vertical slice

Migrate Pi model capability, Model Preset storage/domain/RPC, and old protocol
removal. Keep `ModelPresetSettingsStore` in r-state-tree; make it invoke semantic
Promise operations on the renderer client. Preserve unresolved presets and
serialized optimistic command policy.

## Packet 5 — Pi Services

Complete `PiSessions`, `PiModels`, and `PiAgentResources`; move all Pi package
imports below `src/services/pi`; implement keyed scoped runtime acquisition and
initial Snapshot plus ordered Events.

## Packet 6 — Cake Session domain

Move Project Sessions, Cake Chat Sessions, Discussion Sessions, and Subagents to
shared conversation/domain operations above `PiSessions`. Preserve stable
handles, distinct kind policy, current-first observation, cancellation, and Pi
transcript authority. Remove replaced driver policy vertically.

## Packet 7A — Permanent RendererClient

Extract the broad renderer Promise adapter into focused semantic
`RendererClient` capability groups. Own one renderer Effect runtime for the
window. Translate optional `AbortSignal` to Fiber/RPC interruption and expose
stable renderer-facing errors. Stores must not import Effect or raw RPC.

Delete each replaced `DesktopClient` method and old desktop request/event member
as its capability moves; do not add aliases.

## Packet 7B — Project and Session catalog projections

Create r-state-tree Project and Session summary Models plus focused projection
synchronizers. Consume current-first catalog Streams in projection
infrastructure, not Stores. Preserve stable identity, one observation per
window, ordered revisions, reconnect Snapshots, collision rejection, Project
group indexes, renderer-owned pending sessions, resolved/unread status, and
recent Project ordering.

Store tests inject Promise commands. Projection tests drive controlled Streams
and verify interruption, stale generations, identity, and one-transaction
updates.

## Packet 7C — Loaded conversation projection registries

Create keyed Project Session and Cake Chat projection registries. Each loaded
identity owns exactly one observation and stable r-state-tree Session Model.
Reduce Snapshot plus Events atomically; reconnect from fresh authority; never
persist transcript projections. Keep composer, configuration, panels, and local
workflow policy in focused r-state-tree Stores using `RendererClient` commands.

Then migrate Discussion, Subagent, review, artifact, and extension projections
in dependency-safe vertical slices. Every chat still uses shared `Chat` and
`ChatStore`.

## Packet 7D — Remove broad renderer event routing

After projection registries cover migrated capabilities, remove corresponding
broad `DesktopClientEvent` translation and root event routing. Keep `RootStore`
as application-intent/composition boundary, not projection subscription owner.
Enforce imports:

```text
components → Stores/Models
Stores → RendererClient
projections → CakeIpcClient + Models
```

## Packet 8 — r-state-tree window persistence

Define versioned renderer snapshot data, migrate and validate before mounting or
activating workflow effects, persist only explicit Cake-owned fields after
hydration, and exclude authoritative projections/resources/operations. Verify
startup defaults cannot overwrite stored state.

## Packet 9 — Remaining capabilities

For Git/worktrees, filesystem observation, VS Code, terminal, Electron native
operations, reviews/artifacts, and plugins:

1. define the outside-world Effect Service;
2. move Cake policy to free domain Effects;
3. replace its Effect RPC group;
4. add focused `RendererClient` commands and projection synchronization;
5. update owning r-state-tree Models/Stores;
6. remove the replaced implementation and protocol;
7. run focused main, projection, Store, and Electron verification.

Custom Renderer remains explicitly out of scope.

## Packet 10 — Final enforcement

Remove broad `DesktopClient`, superseded Zod desktop unions/routes, obsolete main
drivers/handlers, direct Effect usage from ordinary Stores/Models, and migration
facades. Keep r-state-tree, one renderer infrastructure Effect runtime, generated
`CakeIpcClient`, permanent Promise `RendererClient`, and projection
synchronizers. Add lint/import boundaries and run full final verification.
