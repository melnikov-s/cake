# Session Family contract

A Session Family is a Cake-owned recursive relationship among ordinary Project
Sessions. It is not a Cake Session kind and does not reuse Pi transcript
ancestry. Pi owns each member's transcript, messages, tools, compaction, and
branching. Cake owns only family identity, parentage, sibling order, fixed
per-member Working Directory bindings, routing correlation, and lifecycle
coordination.

## Membership invariants

- A family is a tree with one root. Every non-root member has exactly one
  immediate parent, and every parent's direct children retain stable creation
  order.
- A standalone Project Session is promoted when its first child reservation is
  persisted. Concurrent first-child requests serialize through family storage
  and produce one family.
- Every member may create children recursively. Members cannot detach, reparent,
  relocate, or replace themselves, and existing sessions cannot be attached.
- Every member belongs to the same Project. Each member's Working Directory is
  fixed at creation. A child either shares its immediate parent's Working
  Directory or receives a Cake-managed worktree branched from that parent's
  current checkout. Child creation cannot select an unrelated base.
- A parent may abort an immediate child's active turn. Aborting does not resolve,
  delete, or detach the child.
- Every member is a normal Project Session runtime and independently owns later
  model and thinking-level changes.

Child creation validates the effective model selection before durable creation.
Omitted model and thinking level inherit the caller's current values. Cake
persists request correlation and child identity before accepting the initial
prompt. Accepting that background turn completes the creation operation; the
parent never waits for the child's turn to settle. Retrying the same request
returns that identity. A launch failure leaves a materialized child tracked and
reports the failed launch; a reservation that never materialized is removed.

Creating an isolated child uses the normal Managed Worktree service with the
caller's Working Directory as `baseWorktreePath`. Git history therefore includes
the parent's committed branch tip, while uncommitted files remain in the parent
checkout and do not carry into the new checkout. Managed Worktree records retain `parentWorktreePath`, and landing
always targets that immediate parent checkout. Cake's repository landing queue
serializes sibling and nested landings. The Managed Worktree engine rejects
landing or discarding a parent worktree while active child worktrees remain, so
nested work lands bottom-up.

## Runtime relationship context

Cake regenerates relationship context whenever a Project Session runtime is
acquired. Every member learns how to create and communicate with children. A
non-root member receives its family and immediate-parent IDs; every member sees
its fixed Working Directory policy. The parent-supplied initial prompt is the
assignment; Cake stores no task copy.

Members sharing a Working Directory observe and modify the same files,
uncommitted changes, and Git index. Cake permits concurrent editing and tells
agents to coordinate it. Members in isolated Managed Worktrees use Cake's
worktree lifecycle operations rather than creating or rebinding worktrees with
Git commands.

Project runtimes expose separate merge, discard, and resolve controls. Singular
operations target the caller; plural merge and discard operations may target
only an immediate child. Merge starts the same preserve-commits, commit-if-dirty,
agent-assisted landing workflow as Cake's UI and enters the repository queue.
Discard uses the normal Managed Worktree retirement operation and may preserve
the branch when requested. Neither operation resolves a session. Shared-checkout
members have no distinct worktree to merge or discard.

## Communication

Family messages use ordinary validated cross-session messaging. Any family
member may be addressed, while completion responsibility follows immediate
parent links. By default, an idle recipient starts a normal turn immediately and
an active recipient receives the message through Pi's follow-up queue. A sender
may explicitly request `steer` to interrupt and redirect an active recipient.
Accepted text becomes authoritative only in the destination Pi transcript; Cake
metadata owns routing and correlation, not a second message copy. Pending input
is projected beside the composer with its source-session attribution and is not
rendered as transcript history. Cancelling a pending steer demotes it to queued
follow-up input instead of discarding the message. Routing is main-process policy
and must not depend on renderer visibility.

For each non-root turn, Cake durably correlates whether a message to that
session's immediate parent was accepted. A normally settled, failed, or aborted
turn with no such acceptance produces one factual notice to the immediate
parent. Stop-all suppresses this reactivation path. Delivery intent survives
restart and is idempotent by child and turn ID.

Pi input acceptance and execution settlement are separate boundaries. Queued
input retains its turn lease until Pi consumes the input and the run settles;
queue insertion alone never triggers a stopped-child notice. Explicit abort uses
the same outcome callback once, even if the original prompt subsequently
returns. Only consumed input IDs count when correlating a child's reply.

Family storage version 3 persists recursive parentage and per-child Working
Directory bindings in addition to pending turns, accepted parent-reply
correlation, notice attempts, and lifecycle journals. Version 1 and 2 documents
migrate their flat children into direct children of the root with the family's
shared Working Directory. The delivery worker retries already-due notices; it
does not monitor assignments or decide what the parent should do. A notice is
acknowledged only when its correlated message is projected from the immediate
parent transcript. Live turn IDs and queued input prevent duplicate delivery
before that acknowledgement. Startup reports interrupted turns and removes
reservations that never materialized a Pi transcript.

## Lifecycle

A non-root member may resolve independently after its turn is inactive, all of
its descendants are already resolved, and it has no undelivered child outcome.
It may be restored only while its immediate parent is active. This preserves
bottom-up resolution and parent-first restoration. Resolving the family root is
an aggregate operation over every member; it requires all members to be inactive
and no family turn to have accepted delivery pending consumption. Main rechecks
these conditions while lifecycle admission is serialized; it never aborts work
or queues a later aggregate resolve.

Aggregate root archive and restore are idempotent multi-transcript operations
tracked by a recoverable journal. Each member is archived from its own Working
Directory. Landed descendant worktrees retire child-first after their final
active session is archived; restore recreates parent worktrees before child
worktrees and then restores transcripts. Transcript namespace remains the
resolved-state authority; the journal records only incomplete aggregate work.
An unrelated active Project Session sharing a Working Directory prevents its
retirement.

Individual member delete and relocation remain prohibited. Ordinary forks are
standalone and never inherit membership. `sessionFamilies` owns creation, turn
admission, and immediate-parent outcome delivery. `projectSessionLifecycle`
owns standalone, individual-member, and aggregate-root archive/restore policy.
Per-family admission locks cover initial creation and aggregate lifecycle work.
Startup replays incomplete journals before the RPC server is exposed; an
incomplete journal blocks new work until recovery succeeds.

## Projection

Catalog summaries project family ID, immediate-parent ID, direct-child IDs,
stable sibling order, and depth. The sidebar derives contiguous depth-first
clusters, latest-descendant ordering, whole-family pagination, subtree collapse,
and aggregate attention. It keeps session titles aligned and renders nesting as
compact vertical depth rails instead of increasing indentation. Collapse state
is window-owned `SidebarStore` state. Each member continues to use the normal
session row, navigation, pane layout, `Chat`, and `ChatStore`.
