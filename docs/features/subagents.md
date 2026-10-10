# Private subagents

Private Subagent Sessions and full Project Session children are different products.
For recursive, selectable Project Sessions, use the
[Session Family contract](../architecture/session-family-contract.md).

## Capability and admission

The `cake` gateway progressively discloses `subagents.*`. Project agents use private
delegation only when the user explicitly requests subagents, delegation, or parallel
agent work. Availability is not authorization.

A Subagent Session is hidden and parent-owned, never a Project Session. The tool
contract cannot attach, fork, select visibility, or expose the backing Pi Session
identity. Handles are parent-scoped and use isolated context. The single general
purpose profile has `read`, `bash`, `edit`, `write`, and a bounded `message_parent`
tool for substantive progress, blockers, or questions. It can address only its
parent, not another Session, and has no Cake application controls.

Subagents receive no recursive delegation, Project context files, skills,
extensions, prompt templates, or themes. Parallel batches accept at most eight
tasks and run at most four concurrently per Working Directory. A task acquires an
active slot before constructing its private Pi runtime.

Requested models are resolved and validated against the parent before any child
construction; parallel batches preflight atomically. Fast mode is allowed only for
models advertised as supporting it, is runtime-scoped, and does not change Project
Session preferences.

## Execution and retention

Delegation starts in the background by default and does not keep the parent turn
open. Foreground run, parallel, and wait are explicit synchronization barriers.
Private runtimes omit Project catalogs, model/command menus, session trees,
artifact indexes, and automatic naming. Live activity is coalesced from part events
rather than rebuilding complete snapshots.

Completion persists a hidden custom Pi message containing the full result for
work-log reconstruction. Only the compact final report enters parent model
context, delivered through normal follow-up queuing without steering or interrupting
parent work. Tool activity, usage, cost, and final output are projected through the
parent tool call, not a second Cake transcript.

Cancellation targets only the requested child. An aborted handle retains its
transcript, partial output, and follow-up capability until explicit close or parent
release. Stopping or redirecting the parent does not cancel subagents. Completed
handles also remain available for follow-up until close or release. Closing a
private parent releases its private descendants.

The renderer uses shared `Chat` to display projected child parts and routes user
prompts, steering, and abort through the parent-scoped handle. It never attaches
to the private Pi Session identity. After release, the side chat is a read-only
projection reconstructed from the parent's transcript.

## Verification

- [Domain lifecycle and concurrency](../../tests/app/domain/subagents.test.ts)
- [Agent capability contract](../../tests/app/agent/subagent-contract.test.ts)
- [RPC boundary](../../tests/app/ipc/subagents-rpc.test.ts)
- [Work-log presentation](../../tests/electron/subagent-work-log.smoke.spec.ts)
