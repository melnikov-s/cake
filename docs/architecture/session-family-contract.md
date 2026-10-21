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
An omitted model resolves the configured default preset's complete settings
(model, thinking level, and Fast mode), not the caller's current values; the
caller's current values apply only when no default preset is configured. Cake
persists request correlation and child identity, then an addressed Workboard
assignment, before admitting the initial bootstrap turn. `assignment: { description,
body }` is required; bootstrap-first `initialPrompt` callers fail validation. Family
creation defaults to resultDelivery notification; reply continuation is a deliberate dependent-work choice.
Accepting that background turn completes creation; the parent never waits for
settlement. The returned assignment receipt proves persistence, not execution;
launch reports accepted, already-admitted with durable journal state, or failed
with its stage. Retrying the returned requestId with unchanged assignment reuses
the identity and entry; initial assignment topics are application-owned.

Assignment-first reservations and isolated worktrees survive preparation failure
and restart for explicit create-child retry. Startup does not auto-activate
pre-admission reservations. After admission, existing durable input recovery owns
restart, deduplication and cancellation. A runtime or transcript alone does not
prove admission. Any existing durable journal, including stopped/canceled or
settled work, prevents retry from relaunching the child. Every later board post uses one durable coalesced delivery cursor/batch per recipient:
explicit audiences plus the unique family root, excluding the author. Nested
immediate parents are not additional orchestrators. Broadcasts automatically
reach only the root; explicitly target other owners. Only necessary assignment/blocker
events permit automatic execution: idle recipients receive one stable input; active
recipients use supported context boundaries. Routine findings/completions are durably
deferred into the recipient's pending batch (see Batched delivery), never active steering.
No concurrent turn, abort, force-send-now or steering of unrelated user inputs occurs.

Completion continuation grants are removed, with v9 storage dropping their
metadata; budgets never gate or double-wake default delivery. Outbox IDs and board
request IDs deduplicate restart/retry; read receipts do not claim execution.
Entry receipts expose scheduled/admitted/notified/consumed/canceled/failed facts,
not understanding or completion. Stop pauses future delivery and withdraws pending
batches; real user input accounts for stopped-period posts before re-enabling
future ones. Queue cancellation and resolved pre-admission batches do not replay.
Creation's initial assignment is excluded from a second generic child wake.

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
its fixed Working Directory policy. The substantive initial assignment lives on the
Workboard; the application-supplied initial prompt only points at its persisted
entry and explains board discovery. Pi remains transcript authority.

Acquisition-time context is not a live eligibility decision. The same runtime can
outlive promotion from standalone to family root or the creation of more children.
`session.info` reads current membership and direct-child order. Agent fork and
resolution-deferral decisions also query live policy rather than captured
membership; operation execution rechecks eligibility. Project capability
registration remains fixed, so changing membership does not require recreating
the runtime or refreshing its system prompt. Agent forks are refused for family
members; ordinary user-created standalone forks remain available.

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
parent links. By default, necessary immediate corrections start an idle recipient normally and
an active recipient receives steering. Explicit queue delivery is reserved for deliberately ordered future work; FYI delivery never starts a turn. A sender
may explicitly request `steer` to interrupt and redirect an active recipient.
Accepted text becomes authoritative only in the destination Pi transcript; Cake
metadata owns routing and correlation, not a second message copy. Pending input
is projected beside the composer with its source-session attribution and is not
rendered as transcript history. Cancelling a pending steer demotes it to queued
follow-up input instead of discarding the message. Routing is main-process policy
and must not depend on renderer visibility.

Session launch/send chooses one `resultDelivery: "reply" | "notification" | "ignore"`.
Global Cake Chat, every Project Chat, Project Session send/reply, independent agent
creation and family creation default to notification. Reply is deliberate dependent-work
continuation; ignore is supported. Stable request/message
correlation identifies the obligation; unrelated input never satisfies it. The envelope's
expectsResponse flag is derived routing metadata, not another caller-selectable mode.

Cake durably records an obligation at Pi input acceptance only when the message
selected reply or notification. Turns the user starts directly, and messages that
asked for no response, are never recorded and never produce completion,
stopped, or failure notices. When the turn that consumed a recorded message
stops, Cake delivers exactly one handoff and removes the record: the explicit
or implicit result when one exists, otherwise one factual failure, canceled, or
stopped notice. Automatic handoffs go to the correlated requester, whether a Project Session, Project Chat or global Cake Chat. Generated notices carry no
response expectation and are never recorded as new obligations, so notification
chains terminate. Stop-all suppresses this reactivation path. Delivery intent
survives restart and is idempotent by request, recipient turn, and
notice-delivery turn IDs.

Pi input acceptance and execution settlement are separate boundaries. Queued
input retains its turn lease until Pi consumes the input and the run settles;
queue insertion alone never triggers a stopped-child notice. Explicit abort uses
the same outcome callback once, even if the original prompt subsequently
returns. Only consumed input IDs count when correlating a child's reply.

### Result delivery

- **Expect reply** (`reply`): application-confirmed completion transports the correlated result
  and automatically starts an idle parent or queues behind active work. No steering or concurrent
  parent turns. The app does not wait for a new user message.
- **Expect notification** (`notification`): retain a compact completion plus an application-generated
  exact source-result message link in the durable inbox. It joins the parent's pending batch
  (see Batched delivery); never start a completion-only parent turn per result.
- **Ignore** (`ignore`): no obligation, result notification or parent turn.

Pi's settled final assistant entry supplies the source entry ID, including restart reconciliation.
Cake generates the exact message reference and preserves it through privacy redaction, classification,
decision retention and notification admission. Artifact/link-only output never selects delivery mode.
Workers need not call sessions.reply to complete an obligation. A manual outcome can classify it;
the application still supplies its final entry link. A legacy already-settled result with no captured
entry identity retains its session link rather than inventing an exact message reference.

Direct questions remain immediate inputs. An explicit blocked report escalates even in notification
mode, after its executing turn settles; this is an actionable blocker, not an ordinary final completion.
Failures, unexpected interruption and result-less stops retain factual handling under the selected mode.
Requester stops, stop-all, queue withdrawal and bounded composer holds preserve existing behavior.
Reply delivery does not also enqueue a later notification; retained review/merge/resolve decisions
are independent metadata and never authorize action. Only correlated accepted inputs create obligations,
so later local user turns never spuriously notify a creator.

Stable request/result/admission IDs, Pi consumption receipts and durable inbox receipts deduplicate
retry/restart transport. This guarantees durable delivery obligations, not exactly-once LLM prose
or a guarantee that the model mentions every delivered notification. Quiet admission and explanation
are distinct; explicit pending-report handling remains the separate private-worker contract below.
Private subagents retain continuation:none/resume; Workboard grants remain independently authorized.

### Quiet worker report handling

A private worker with continuation:none transfers a compact result handoff to the durable
report inbox, not to a parent turn. Its worker `notified` disposition records that transfer,
not model delivery or user communication. Input admission only increments an intake counter;
it never drains the inbox. Five fairly rotated pending items are attached to each real user
input (up to 4,000 characters each initially, 300 on replay). Commands and cross-session
inputs do not drain or trigger the group. Overflow is discoverable via `sessions.reports`;
`sessions.reports.read` retrieves one exact handoff in bounded slices. Inline evidence and
unread linked originals are labelled separately; worker handle, Pi identity, task and status
remain attached. No report-only wakeup, timer or poll is introduced. Resume delivery is unchanged.

`sessions.reports.acknowledge` is an explicit agent attestation, not a semantic classifier.
It requires exact assistant text already emitted in the requesting conversation after its
latest consumed user input, with a persisted Pi entry and complete text status. Reasoning,
context, tools, queued inputs and planned final answers are not evidence. The agent emits
a grouped notice first, then acknowledges its IDs as communicated (or dismissed only on
the user's decision). Backend validation proves the evidence exists, not that the words
adequately summarize the report. Successful or unrelated answers never auto-acknowledge.
Omission, failure, abort and restart leave the workflow obligation intact. Handling atomically
removes pending payloads and retains small conversation-scoped ID/evidence receipts, so
retries cannot duplicate handled results. Exact conversation history remains solely Pi-owned.

Durable memory labels embedded handoffs as received work, separately from the real user
input; provenance and pending-at-intake are supplied to compression. Historical intake is
not current communication state: the durable workflow inbox/receipts remain authoritative
even if a lossy summary drops details, and pending reminders are reattached on user turns.
This does not reconstruct reports already removed by older admission-based delivery.

### Workboard delivery and quiet decisions

Default board delivery is defined above: explicit audience plus the unique root.
Routine updates are passive; necessary assignments/blockers retain durable execution.
The retired completion-grant mechanism contributes neither a second wake nor an
execution budget. Board content and intake never expand user authorization.

Separately, `completionInbox` retains ready/blocked/investigation results and pending
review/merge/resolve/next-step decisions, scoped to the requesting conversation. Typed board
results addressed to their parent participate even with no execution grant; broadcasts do not.
Implicit unclassified answers are investigations; explicit completed reports or resultKind classify
ready work, with merge suggestions only for ready isolated sessions. `sessions.completions`
pages pending/deferred records; update changes only decision metadata, never executes actions
or rearms notices.

`recordCompletion` atomically deduplicates the retained decision and, for notification mode or board results, its one-time coordinator
digest. Reply mode retains decisions without a second quiet notice. Both ordinary Project Sessions and permanent chats attach at most twenty new result
notices to the next real user input or batched turn. Linked reports retain exact references in the same group,
not duplicate private reminders. The shared renderer displays compact status and result links alongside that user input without
requiring an agent relay. Model-facing orientation asks it to answer the user first and explain
results only when useful. Decisions survive delivery without repeated nags.
Admission receipts prevent replay when accepted input outlives digest removal. No transcript
is copied: full reports remain Pi-owned. Execution continuation is independent of this inbox.

### Batched delivery

Everything deferred instead of waking a conversation accumulates in one pending batch per
recipient conversation (global Cake Chat, a Project Chat or a parent Project Session):
coordinatorDigest notification results, undelivered passiveNotices (delivery fyi and routine
Workboard posts) and never-admitted deferredReferences (quiet worker reports). Already admitted
reports remain discoverable but do not rearm a timer.

- `updateBatches` holds one durable timer record per recipient: `openedAt`, `dueAt` and an
  optional admission `turnId`. The application delivery worker (`updateBatches.runPass`, run by
  the existing session-result pass) opens the record when it first sees pending items, so a
  missing record is re-derived after restart.
- `dueAt` is the earlier of `openedAt + 5 minutes` and 30 seconds before the recipient's
  estimated prompt-cache expiry (`sessionContextCost`, the sessions.list estimate). An unknown or
  expired cache keeps the 5-minute window. Later items join without moving the deadline.
- A real user input carries every pending item as before and closes the record.
- When due, the worker waits while the recipient streams, has active turns or queued input,
  holds a Cake Chat composer draft, is explicitly stopped/blocked, or is resolved. Items that arrive
  meanwhile join the waiting batch. It then admits one follow-up input with `internal: UpdateBatch`,
  the digest/reference reminders, passive notices and a `Cake batched updates` reminder. There is no
  user text; the transcript shows only Cake context pills.
- The admission `turnId` is recorded before submission. After a restart, an existing Pi input
  receipt settles exactly the notices marked with that turn and the journaled digest receipts;
  otherwise the batch is rebuilt. Items arriving during an in-flight batch open the next batch.

Reply mode, direct questions and blockers remain immediate and are not batched.

### Permanent chat delivery

Global Cake Chat and permanent Project Chat share the result-delivery mechanism above, scoped
to the requesting chat identity. Notification entries live in coordinatorDigest and are removed
only after the next real user input or batched turn is durably accepted; admission receipts prevent replay.
They carry compact status, classification, pending decisions and the exact resultMessageRef.
The shared transcript renders those lines as an application-owned Session results notice with
clickable result links at user-input admission, even if the model produces no explanation.
Only the model-facing orientation remains context; an agent relay is not required.
Reply admissions use the normal parent queue and stable automatic-report ID. Consumption or
cancellation receipts settle retries even after transcript compaction. Composer holds are bounded
by the existing two-minute presence timeout. A user input retains priority over a report-started run.

Launch records retain launchedAt and lastReport for activity/status surfaces, independently of
notification delivery. No initial obligation is recorded for ignore launches. Historical digest
records without a requester identity still belong to global Cake Chat.
Launch projections include requester identity; both sessions.list and the Activity menu filter
by that identity. The shared Activity menu also presents a regular Project Session's direct
family children and each conversation's own temporary subagents in separate groups. It is
hidden unless delegated work is running, queued, or needs attention; idle sessions alone do
not keep it visible. Sessions open through ordinary navigation; subagents use their owner's
existing side-chat surface.

Family storage version 8 migrates persisted report/continuation combinations to resultDelivery without dropping pending obligations, inboxes, correlations, delivery attempts or handled receipts. Explicit resume maps to reply, none to notification, otherwise digest maps to notification and immediate/default obligations to reply. Versions 1–7 remain readable; new writes contain only canonical modes. Persisted Pi envelopes decode their historical fields at the transcript boundary.

Family storage version 5 established recursive parentage, per-child Working
Directory bindings, sender/recipient request and reply correlation, response
expectations, and notice attempts. Version 6 extends the same journal to
coordinator-spawned independent sessions; the Cake Chat report policy above defines how its results are delivered.
Queue acceptance alone does not confirm result delivery. The journal has no
per-child resolution state or lifecycle synchronization journals. Version 4 journals are discarded on decode;
the root's Cake-owned resolution metadata determines the entire family's state. Version 1 and 2 documents
migrate their flat children into direct children of the root with the family's
shared Working Directory; version 3 recursive documents migrate legacy turns as
response-expected work. The delivery worker retries already-due notices; it does
not monitor assignments or decide what the sender should do. A notice is
acknowledged only when its correlated message is projected from the sender's
transcript. Live turn IDs and queued input prevent duplicate delivery before
that acknowledgement. Startup reports interrupted turns and removes reservations
that never materialized a Pi transcript.

### Shared Workboard

The first child reservation creates one **Workboard** (`message-board` artifact kind) linked to the family. Within the board, participating sessions are workgroup members rather than parent/child/sibling roles. Its title uses the originating session's title when available, otherwise `Workboard`; the type label stays `Workboard`. Append requires an explicit audience: target affected owners with session references, or choose `workgroup` for genuinely shared decisions. Canonical session IDs remain stored. Its deterministic identity and the family creation lock preserve one board across concurrent creation, retries, descendants and isolated Working Directories. Existing families acquire their board at normal runtime intake. Members append immutable entries containing a description, body, audience, author session, timestamp and increasing sequence, with optional stable `topic` and `supersedes` sequence references. Supersession requires a topic and existing earlier entries in that same topic (or untagged originals); storage validates this under the append lock. Cake stamps attribution and serializes appends. This is shared coordination data, not a replacement assignment scheduler or user authorization.

`boards.read-new` discovers bounded relevant unread, non-superseded descriptions (including previously notified but deferred entries); `boards.read` retrieves selected bodies. `boards.current` pages current relevant descriptions, optionally by topic, regardless of existing receipts. Neither discovery query records body reads. A relevant successor explicitly supersedes its referenced entries for its recipients only; narrower audiences cannot hide decisions from other recipients. Superseded originals remain available through explicit reads, receipts and human browsing. Current denotes explicit relationships, not semantic agreement, verification or a uniquely authoritative proposal. Family-wide and explicitly addressed descriptions are eligible for notifications; authors do not receive notices of their own posts. Audience is routing, not privacy: family members may explicitly browse any entry. Entry and session receipt queries expose independent first-notified and first-read timestamps. Read means content supplied to a tool caller, not comprehension, agreement, action or memory after compaction. Human artifact browsing never records agent receipts.

Necessary assignment/blocker events use Pi's supported context-only boundaries and durable idle fallback. Routine descriptions/completions are not injected at active boundaries: the durable passive inbox delivers them with the recipient's pending batch with typed provenance. Notification/read receipts are not understanding or execution evidence. Explicit stop, queue withdrawal and resolution remain authoritative; no acknowledgment or private relay is required.

## Lifecycle

Only the family root owns resolution. Every child inherits its immediate parent's
resolution recursively, so every descendant derives the root's state. A child's
own transcript location never determines whether it is resolved. Resolve and
restore requests must address the root authority; requests addressed to a child
are rejected rather than silently redirected. Resolution
requires all members to be inactive and no family turn to have accepted delivery
pending consumption. Main rechecks these conditions under the family admission
lock; it never aborts work or queues a later resolve. A resolution deferred while
the caller was standalone is guarded at settlement: promotion into a family
rejects that intent rather than resolving the newly formed family.

Resolving updates only the root's Cake-owned resolution metadata and publishes the
authority change before attempting checkout cleanup. Every Pi transcript stays in
its normal directory. Catalogs, conversation observations, message admission, and
cleanup eligibility derive resolution from the root, including when older per-member
metadata disagrees.
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
