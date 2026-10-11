# Backend workflow refinement — review skeleton

**Status: proposed implementation contract; awaiting user approval.** The three
architectural principles are agreed. The concrete interfaces, scope, and tests in
this diff are not yet approved. No implementation children have been launched.

Investigation base: `b5047ae5`. The skeleton commit will be recorded in the shared
coordination artifact before delegation. Runtime callers still use the existing
implementation. Unconnected stubs deliberately fail if invoked; `it.todo` cases
are acceptance specifications, not passing verification of the proposed behavior.

## Agreed principles

1. Substantial workflows are named free backend Effects. Runtime callbacks adapt
   inputs, caller context, cancellation, and results rather than own the workflow.
2. Specific Effect errors distinguish a known refusal from a committed resolution
   followed by failed cleanup. Preserve those distinctions to application handling.
3. Capture fixed runtime configuration, but query mutable policy at execution.
   Exposed controls and policy snapshots are not admission permits.

No domain-object framework, per-feature Services, Store consolidation, new
transaction engine, transcript authority, durable operation journal, or automatic
mutation replay is part of this work.

## Child A — messaging extraction and live runtime policy

### Messaging

`sessionFamilyMessaging.route(caller, command, input, senderContext?)` owns the
existing family routing operation. Decode `FamilyMessageInput` in the runtime
callback, then invoke the operation through the existing Pi callback executor.
Keep its caller-owned Scope and cancellation. Runtime acquisition remains the
existing `projectSessionRuntime.acquireOptions` composition point; no runtime
factory Service or callback registry is introduced.

Move the complete existing family reply selection, completion-report handling,
destination lookup, lifecycle checks, metadata construction, response tracking,
delivery choice, receipt bookkeeping, and catalog publication together. Preserve
coordinator routing and `undefined` as the existing not-handled fallback. Convert
expected routing failures to `ProjectSessionError` without erasing their messages;
do not convert interruption or defects to ordinary failures. Do not rewrite the
Pi queue, report worker, or child-creation workflow.

### Live policy

`projectSessionAgentPolicy.read(sessionId)` reads current family membership and
returns the proposed `ProjectSessionAgentPolicy` contract. Standalone sessions
can fork through the agent and may defer their own resolution; family members
cannot agent-fork and cannot defer family resolution. Family information retains
the current immediate-parent/root-role semantics and direct-child ordering.

At cutover, `currentSessionControl` composes `ProjectSessionLivePolicyControl`:

- `readPolicy(): Promise<ProjectSessionAgentPolicy>` replaces captured
  `familyInfo` and the boolean `deferResolution`; remove both old fields.
- `resolveDeferredStandalone(): Promise<void>` uses Child B's guarded domain
  operation, never the general family-capable resolver.

Keep Project Session control registration based on its fixed profile/capabilities,
not initial membership. `session.info` queries current family information (make
its internal operation API asynchronous). Fork scheduling checks current policy;
execution rechecks through `assertCanFork` before invoking the existing fork
workflow. This agent restriction does not prohibit ordinary user-created
standalone forks from family sessions. Do not recreate runtimes or refresh system
prompts merely because membership changes.

Resolution checks current deferral policy. A deferred standalone request must not
later gain family-wide authority: if the session becomes a family parent before
settlement, the guarded operation rejects it. Leave state-changing eligibility
checks with the existing authoritative operations and admission locks; do not
nest an already-locking public operation inside its own non-reentrant lock.

Child A also handles the shared resolution error at the Pi continuation boundary:
`ResolutionCleanupFailed` means resolution succeeded, so report the committed
state plus cleanup details, not “Could not resolve session.” For an immediate
agent result, retain the normal resolution fields and add `cleanupFailures`;
for deferred completion, emit an accurately titled inspectable cleanup notice.
Other operational and interruption behavior remains intact.

## Child B — resolution outcomes through backend, RPC, and renderer

The new shared resolution module defines:

- `ResolutionRejected`: a known pre-commit policy refusal, with affected IDs and
  a message. Use for known active/pending, empty, non-root, outstanding-outcome,
  and family-promotion admission refusals—not arbitrary I/O failures.
- `ResolutionCleanupFailed`: confirms resolution committed, carrying all resolved
  session IDs and observed cleanup failures with their Working Directories.
- The existing Working Directory batch result, relocated without forwarding
  aliases, with an explicit `cleanupFailures` array alongside `failures` and
  `resolvedSessionIds`. Committed IDs remain in the success list even when cleanup
  fails; ordinary unresolved/operational failures remain in the existing summary
  list. This extends the existing batch API, not a second result framework.

Single-session resolution RPC errors are the union of the two new variants and
`ProjectSessionError`. Preserve the variants through all resolution-specific error
mapping. Generic operational errors, interruption, and lost transport receipts
remain potentially uncertain; never reinterpret them as “nothing changed.”
Keep ordinary successful `resolve` returning void and restore behavior unchanged.

`resolveDeferredStandalone(target)` rechecks membership and resolves under the
same existing admission lock. It rejects promotion to a family and shares the
existing standalone transition implementation rather than duplicating it.

Preserve root-only resolution authority, publication ordering, and current
child-first cleanup order/stop behavior. No rollback of committed resolution and
no new cleanup retry scheduler. The error reports observed failure, not a claim
that every other checkout was cleaned. Narrow post-commit finalization as needed
so the known commit is not lost merely to caller interruption; do not make long
Git cleanup uninterruptible or invent restart durability.

### Promise client and presentation

`ClientError.domainFailure` carries only the allowlisted, validated resolution
variants. It does not expose arbitrary rejected objects or Effect runtime values.
Keep `ClientError` as the presentation boundary and Stores Effect-free. A received
domain outcome must not be replaced by generic cancellation merely because the
signal became aborted later. Real transport interruption remains uncertain, with
no automatic command replay.

`SessionManagementStore` treats committed cleanup failure as resolution success
for retirement/navigation while reporting cleanup details. Use the authoritative
IDs where family retirement needs them. Batch callers retire committed IDs and
present both failure lists. Do not mutate projection authority to manufacture
success; retain disposal and stale-navigation protections.

The merge-and-resolve caller must also consume the extended batch result. A
completed landing and resolution with cleanup failures stays `landed`; carry the
warnings in the optional `WorktreeLandingOperation.cleanupFailures` projection
and present them through the existing UI. Clear completed resolve intent as for
successful resolution; do not retry Git landing to repair checkout cleanup.

## Exact initial ownership

Both children implement their production slice and associated regression tests.
No recursive delegation. Shared contracts in this skeleton are frozen after
approval; an implementation may not silently change them.

### A owns

- `src/domain/session-families/sessionFamilyMessaging.ts`
- `src/domain/project-sessions/projectSessionAgentPolicy.ts`
- `src/domain/project-sessions/projectSessionRuntime.ts`
- `src/services/pi/runtime/cake-session-runtime.ts`
- `src/services/pi/runtime/cake-session-runtime-capabilities.ts`
- `src/services/pi/runtime/cake-session-runtime-continuations.ts`
- `tests/app/domain/sessionFamilyMessaging.test.ts`
- `tests/app/domain/projectSessionAgentPolicy.test.ts`
- `tests/app/domain/sessionFamilyReplySelection.test.ts`
- `tests/app/domain/projectSessionRuntimeWorktreeControls.test.ts`
- `tests/app/domain/projectSessionRuntimeChildActivity.test.ts`
- `tests/app/domain/sessionFamilyRootSettlement.test.ts`
- `tests/app/domain/spawnedSessionReporting.test.ts`
- `tests/app/services/pi/cake-session-runtime-continuations.test.ts`

### B owns

- `src/domain/project-sessions/projectSessionLifecycle.ts`
- `src/ipc/project-session-data.ts` and `src/ipc/protocol/ProjectSessionRpc.ts`
- `src/ipc/server/ProjectSessionHandlers.ts`
- `src/renderer/client/Client.ts` and `src/renderer/client/ClientLive.ts`
- `src/renderer/stores/SessionManagementStore.ts`
- `src/renderer/stores/SessionRetirementStore.ts`
- `src/renderer/stores/ProjectWorkbenchStore.ts`
- `src/domain/worktrees/worktreeLandings.ts`
- `src/services/worktrees/WorktreeLandingCompletion.ts`
- `src/layers/WorktreeLandingCompletionLive.ts`
- `src/renderer/models/WorktreeOperation.ts`
- `src/renderer/reducers/WorktreeOperationReducer.ts`
- `src/renderer/stores/WorktreeStore.ts`
- `tests/app/domain/projectSessions.test.ts`
- `tests/app/domain/worktreeLandings.test.ts`
- `tests/app/renderer/Client.test.ts`
- `tests/app/renderer/generated-client.test.ts`
- `tests/app/renderer/session-management-workflow.test.tsx`
- `tests/app/renderer/working-directory-retirement-workflow.test.tsx`
- `tests/app/renderer/worktree-workflow.test.tsx`

The parent owns the shared contract files, this proposal, normative documentation,
coordination record, integration, final review, and verification. The new deferred
resolver is B's implementation and A's caller; its signature is fixed before both
start. A owns all Pi continuation edits, including handling B's typed errors.
Mechanical import/fixture updates elsewhere are report-only unless they overlap
another child's ownership. Behavior, shared-interface, or lifetime changes require
approval. Children send one substantive completion report, or one actionable
blocker/contract-amendment request if needed.

## Cutover map and verification

**Keep:** existing authorities, runtime leases, queues, locks, lifecycle commit
order, user fork behavior, ordinary Promise client, and integration tests.
**Move:** family message workflow/schema out of runtime assembly; Working Directory
resolution result schemas into the new shared contract file.
**Replace:** captured membership controls with live policy; generic handling of
known resolution outcomes with tagged handling.
**Delete:** moved callback bodies, old schema definitions/import paths, captured
`familyInfo`/`deferResolution` fields, skeleton markers, and superseded duplicate
tests. No compatibility aliases. Every accepted `it.todo` becomes a real test;
merge it into an existing equivalent case rather than duplicate coverage.

Use two isolated child worktrees from the approved skeleton commit. They can
implement in parallel against the frozen interfaces; the parent lands and checks
the combined implementation. No implementation or child launch before approval.

Verification includes the named test cases in this diff, existing family
creation/delivery/reporting and runtime-control suites, lifecycle/landing suites,
encoded RPC-to-real-client coverage, and real renderer workflow tests. Tests fake
external boundaries, not the coordinating logic under test. Coordinate races with
explicit gates, not elapsed-time sleeps.

Format, typecheck, Oxlint, ESLint, and unused-code checks apply to the integrated
implementation. Run targeted Electron verification after building if affected
sidebar/worktree interactions depend on native input or DOM behavior; do not run
the full e2e suite by default. Skeleton checks establish only that the proposed
contracts compile and existing behavior is unchanged, not that TODO behavior works.
