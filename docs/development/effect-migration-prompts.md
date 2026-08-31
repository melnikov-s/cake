# Effect migration bulk-pass prompts

Phases 0–6 are complete. These prompts optimize remaining work for speed,
context reuse, and token efficiency—not a runnable application at each internal
step.

## Common execution contract

1. Read required architecture and installed API guidance once at pass start.
2. Inventory the complete pass and record the final dependency/file shape.
3. Work in dependency order; temporary compile/test/lint/runtime failures are
   acceptable.
4. Do not add aliases, dual protocols, forwarding facades, duplicate state, or
   temporary adapters solely for intermediate executability.
5. Preserve Pi authority, renderer sandboxing, one RPC protocol, and the final
   r-state-tree/`RendererClient`/projection boundary.
6. Group mechanical edits and delete old paths after all callers move.
7. Run broad formatting/verification once at the checkpoint. Run an earlier
   focused check only to answer a concrete implementation question.
8. Do not update progress or hand off internal substeps. Savepoint commits may be
   broken and exist only for recovery.

## Bulk Pass A — Final renderer boundary

Establish final renderer infrastructure in one pass:

- one window-owned `RendererRuntime` and semantic Promise `RendererClient`;
- all Effect command adaptation moved out of `DesktopClient`, with cancellation
  propagation and stable renderer failures;
- one small window-owned Model synchronizer for Stream subscription, Update to
  snapshot mapping, `applySnapshot`, revision/generation filtering, Snapshot
  reconnect, and disposal;
- final Store/client injection, with only `RootStore` supplying loaded Models to
  the synchronizer;
- every renderer caller moved mechanically to the final client;
- replaced Promise methods, duplicate runtime helpers, and migrated raw bridge
  operations deleted without forwarding aliases.

Do not preserve compilation during the caller sweep. Checkpoint only after it is
complete: format, Oxlint, typecheck, focused client/runtime tests, and Effect RPC
Electron smoke coverage.

## Bulk Pass B — All renderer state and persistence

Convert the whole renderer state layer in dependency order:

- all r-state-tree projection Models moved/created in final locations;
- every authoritative Project, Session, Cake Chat, Discussion, Subagent, review,
  artifact, extension UI, and related Stream wired through the single Bulk Pass A
  Model synchronizer;
- all Stores changed to read stable Models and call `RendererClient`;
- broad `DesktopClientEvent`, root projection routing, per-Store authoritative
  subscriptions, and duplicate state removed;
- final versioned r-state-tree hydration/persistence implemented after the Store
  tree shape is final;
- superseded renderer helpers, fixtures, schemas, events, and facades deleted.

Preserve one observation per identity, stable Model identity, Snapshot/Event
ordering, stale-generation rejection, and one transaction per logical Update.
Checkpoint once with full renderer lint/typecheck/tests, build, and affected
chat/sidebar Electron tests.

## Bulk Pass C — Remaining privileged capabilities

Migrate in one pass: Electron/filesystem; Git/Managed Worktrees/storage; VS Code
Server/Terminal; reviews/artifacts/Discussion; plugins/storage/activation/
recovery.

Define final Services, free domain Effects, RPC groups, renderer wiring, and all
callers first; then delete old Zod desktop operations, imperative handlers,
drivers, registries, and superseded tests together. Do not verify each
capability as a runnable slice. Use focused checks only for uncertain
boundaries, then run one full checkpoint at pass end.

Custom Renderer remains out of scope.

## Bulk Pass D — Final cleanup and release verification

Remove broad `DesktopClient`/events, obsolete routes/drivers/handlers/resource
maps, forwarding APIs, migration helpers, stale tests, and terminology. Keep
r-state-tree, one renderer Effect runtime, generated `CakeIpcClient`, permanent
`RendererClient`, and the one window-owned Model synchronizer. Add final import boundaries,
reconcile docs, and run the release matrix once. Never restore compatibility
code to satisfy a failure.
