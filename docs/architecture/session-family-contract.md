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

Each accepted family message carries an explicit `expectsResponse` value and
stable request/message correlation. Initial child assignments and ordinary
explicit sends default to `true`; replies default to `false`. Callers set
`expectsResponse: false` for substantive results and informational notices. A
reply clears only the request identified by its reply correlation; an unrelated
message in the same family or thread does not satisfy the obligation.

Cake durably records response obligations at Pi input acceptance and settles
them only after the consumed turn stops. Successful work with no response
expectation clears silently. If a response-expected turn stops without an
accepted correlated reply, Cake sends exactly one factual notice to the original
sender, whether that sender is the immediate parent or another family member.
Failed or aborted work remains factually visible even when no response was
expected, but generated notices carry no response expectation and are never
recorded as new notification work, so notification chains terminate. Stop-all
suppresses this reactivation path. Delivery intent survives restart and is
idempotent by request, recipient turn, and notice-delivery turn IDs.

Pi input acceptance and execution settlement are separate boundaries. Queued
input retains its turn lease until Pi consumes the input and the run settles;
queue insertion alone never triggers a stopped-child notice. Explicit abort uses
the same outcome callback once, even if the original prompt subsequently
returns. Only consumed input IDs count when correlating a child's reply.

Family storage version 5 persists recursive parentage, per-child Working
Directory bindings, sender/recipient request and reply correlation, response
expectations, and notice attempts. It has no per-child resolution state or
lifecycle synchronization journals. Version 4 journals are discarded on decode;
the root's actual transcript namespace determines the entire family's state. Version 1 and 2 documents
migrate their flat children into direct children of the root with the family's
shared Working Directory; version 3 recursive documents migrate legacy turns as
response-expected work. The delivery worker retries already-due notices; it does
not monitor assignments or decide what the sender should do. A notice is
acknowledged only when its correlated message is projected from the sender's
transcript. Live turn IDs and queued input prevent duplicate delivery before
that acknowledgement. Startup reports interrupted turns and removes reservations
that never materialized a Pi transcript.

## Lifecycle

Only the family root owns resolution. Every child inherits its immediate parent's
resolution recursively, so every descendant derives the root's state. A child's
own transcript namespace never determines whether it is resolved. Resolve and
restore requests addressed to any member target the root authority. Resolution
requires all members to be inactive and no family turn to have accepted delivery
pending consumption. Main rechecks these conditions under the family admission
lock; it never aborts work or queues a later resolve.

Resolving archives only the root transcript and publishes the authority change
before attempting checkout cleanup. Child transcripts stay in place. Catalogs,
conversation observations, message admission, and cleanup eligibility derive
resolution from the root, including when older stored namespaces disagree.
There is no member-by-member lifecycle transition or synchronization journal.
Landed descendant worktrees retire child-first after their final effectively
active session is resolved. A cleanup failure cannot leave children unresolved.
Restoring recreates parent worktrees before child worktrees, normalizes any
archived child transcripts from older installations, and restores the root last.
Older archived children are also normalized when acquiring their runtime; this
storage operation never changes their inherited lifecycle state. An unrelated
active Project Session sharing a Working Directory prevents its retirement.

Individual member delete and relocation remain prohibited. Ordinary forks are
standalone and never inherit membership. `sessionFamilies` owns creation, turn
admission, and immediate-parent outcome delivery. `projectSessionLifecycle`
owns standalone and family-root archive/restore policy. Per-family admission
locks cover creation, turn acceptance, and root lifecycle work. Startup requires
no child-resolution replay.

## Projection

Catalog summaries project family ID, immediate-parent ID, direct-child IDs,
stable sibling order, depth, and resolution derived from the root. These
window-lifetime projections are not independent lifecycle authorities. The
caller-scoped `sessions.list-family` Cake operation exposes only the calling
Project Session's family in stable depth-first order; unlike `sessions.list`, it
never accepts a target ID or includes unrelated sessions. A root change refreshes
the entire family, including descendants in retired worktrees and transcripts
still physically in active storage. The sidebar derives contiguous depth-first
clusters, latest-descendant ordering, whole-family pagination, subtree collapse,
and aggregate attention. It keeps session titles aligned and renders nesting as
compact vertical depth rails instead of increasing indentation. Collapse state
is window-owned `SidebarSessionListStore` state beneath `SidebarStore`. Each
member continues to use the normal
session row, navigation, pane layout, `Chat`, and `ChatStore`.
