# Session Family contract

A Session Family is a Cake-owned relationship among ordinary Project Sessions.
It is not a Cake Session kind and does not reuse Pi transcript ancestry. Pi owns
each member's transcript, messages, tools, compaction, and branching. Cake owns
only family identity, membership, ordering, routing correlation, and lifecycle
coordination.

## Membership invariants

- One parent has zero or more direct children in stable creation order.
- A standalone Project Session is promoted when its first child reservation is
  persisted. Concurrent first-child requests serialize through family storage
  and produce one family.
- Children cannot create children, detach, reparent, or replace themselves.
- Existing sessions cannot be attached.
- Every member has the same Project, normalized Working Directory, and Managed
  Worktree association. These bindings do not change during family membership.
- A child is a normal Project Session runtime and independently owns later model
  and thinking-level changes.

Child creation validates the effective model selection before durable creation.
Omitted model and thinking level inherit the caller's current values. Cake
persists request correlation and the child identity before accepting the initial
prompt. Retrying the same request returns that identity. A launch failure leaves
the child tracked and reports the failed launch instead of deleting membership.

## Runtime relationship context

Cake regenerates relationship context whenever a Project Session runtime is
acquired. Standalone and parent sessions learn how to create and communicate
with children. Child sessions receive their family and parent IDs, fixed Working
Directory policy, and one-level delegation restriction. The parent-supplied
initial prompt is the assignment; Cake stores no task copy.

All members sharing a Working Directory can observe and modify the same files,
uncommitted changes, and Git index. Cake permits concurrent editing and tells
agents to coordinate it. Agent-created Git worktrees do not rebind Cake.

## Communication

Family messages use ordinary validated cross-session messaging. Accepted text
becomes authoritative only in the destination Pi transcript; Cake metadata owns
routing and correlation, not a second message copy. Routing is main-process
policy and must not depend on renderer visibility.

For each child turn, Cake durably correlates whether a parent-directed message
was accepted. A normally settled, failed, or aborted child turn with no such
acceptance produces one factual notice to the parent. Stop-all suppresses this
reactivation path. Delivery intent survives restart and is idempotent by child
and turn ID.

Pi input acceptance and execution settlement are separate boundaries. Queued
input retains its turn lease until Pi consumes the input and the run settles;
queue insertion alone never triggers a stopped-child notice. Explicit abort
uses the same outcome callback once, even if the original prompt subsequently
returns. Only consumed input IDs count when correlating a child's reply.

Family storage version 2 persists pending turns, accepted parent-reply
correlation, notice attempts, and lifecycle journals. The delivery worker
retries already-due notices; it does not monitor assignments or decide what the
parent should do. A notice is acknowledged only when its correlated message is
projected from the parent transcript. Live turn IDs and queued input prevent
duplicate delivery before that acknowledgement. Startup reports interrupted
turns and removes reservations that never materialized a Pi transcript.

## Aggregate lifecycle

Only the parent can resolve or restore. Resolve requires every member to be
inactive and to have no accepted delivery pending consumption. Main rechecks
this condition while lifecycle admission is serialized; it never aborts work or
queues a later resolve. Resolve archives every member. Restore restores every
member explicitly; messaging a resolved member never restores a family.

Archive and restore are idempotent multi-transcript operations tracked by a
recoverable journal. Transcript namespace remains the resolved-state authority;
the journal records only incomplete work. Individual member delete, handoff,
relocation, and resolve/restore paths reject family members. Ordinary forks are
standalone and never inherit membership.

`sessionFamilies` is the shared main-process domain for creation, admission,
lifecycle transitions, and outcome delivery. The existing Project Session
environment wires its runtime callbacks; both resolution entry points use the
same lifecycle policy. Per-parent admission locks cover initial creation and
the complete archive/restore operation. Startup replays incomplete journals
before the RPC server is exposed. An incomplete journal continues to block new
work until recovery succeeds.

## Projection

Catalog summaries project family IDs, the parent ID, stable child order, and the
parent's child IDs from canonical storage. The sidebar derives contiguous
clusters, latest-member ordering, whole-family pagination, and aggregate parent
attention. Collapse state is window-owned `SidebarStore` state. Each member
continues to use the normal session row, navigation, pane layout, `Chat`, and
`ChatStore`.
