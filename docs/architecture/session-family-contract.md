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
parent links. By default, an idle recipient starts a normal turn immediately and
an active recipient receives the message through Pi's follow-up queue. A sender
may explicitly request `steer` to interrupt and redirect an active recipient.
Accepted text becomes authoritative only in the destination Pi transcript; Cake
metadata owns routing and correlation, not a second message copy. Pending input
is projected beside the composer with its source-session attribution and is not
rendered as transcript history. Cancelling a pending steer demotes it to queued
follow-up input instead of discarding the message. Routing is main-process policy
and must not depend on renderer visibility.

Session launch/send chooses one `resultDelivery: "reply" | "notification" | "ignore"`.
Cake Chat defaults to notification, Project Session sends/replies to ignore, and family
creation to reply (Workboard-only children explicitly select ignore). Stable request/message
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
  exact source-result message link in the durable inbox. Attach it only to the next real user
  message; never start a completion-only parent turn.
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

### Workboard continuation and quiet decisions

Workboards remain passive unless a recipient explicitly grants `boards.continuation.set`.
The grant persists an authorization ID, topic/expected authors, finite remaining parent-input
budget (one by default, at most ten), cursor, completed-author credit and a stable pending input ID.
New grants start after existing entries unless an explicit `after` cursor opts older results in.
Only current typed completion/blocker entries explicitly addressed to the recipient qualify;
self, broadcast, wrong-author/topic, untyped and superseded posts never do. Expected-author
batches coalesce into one inspection; a blocker may break the barrier without losing
previous completion credit.

The existing family notice worker admits at most two outstanding Workboard inputs globally
and one per recipient, behind active/queued user work, using normal durable runtime admission.
It persists the ID/budget before submission and consults Pi consumption and durable cancellation
receipts on retry. Failed/aborted execution or explicit session abort pauses future admission;
paused/off grants do not abort an already-admitted turn. Resolved/missing members relinquish
pending capacity. Runtime recovery gates remain authoritative. This limits automatic input
count/concurrency, not monetary cost or tokens within an individual model turn.
Board intake/read receipts are not execution receipts. No private report obligation is created,
and completion never expands mutation/delegation authorization.

Separately, `completionInbox` retains ready/blocked/investigation results and pending
review/merge/resolve/next-step decisions, scoped to the requesting conversation. Typed board
results addressed to their parent participate even with no execution grant; broadcasts do not.
Implicit unclassified answers are investigations; explicit completed reports or resultKind classify
ready work, with merge suggestions only for ready isolated sessions. `sessions.completions`
pages pending/deferred records; update changes only decision metadata, never executes actions
or rearms notices.

`recordCompletion` atomically deduplicates the retained decision and, for notification mode or board results, its one-time coordinator
digest. Reply mode retains decisions without a second quiet notice. Both ordinary Project Sessions and permanent chats attach at most twenty new result
notices to the next real user input. Linked reports retain exact references in the same group,
not duplicate private reminders. The shared renderer displays compact status and result links alongside that user input without
requiring an agent relay. Model-facing orientation asks it to answer the user first and explain
results only when useful. Decisions survive delivery without repeated nags.
Admission receipts prevent replay when accepted input outlives digest removal. No transcript
is copied: full reports remain Pi-owned. Execution continuation is independent of this inbox.

### Permanent chat delivery

Global Cake Chat and permanent Project Chat share the result-delivery mechanism above, scoped
to the requesting chat identity. Notification entries live in coordinatorDigest and are removed
only after the next real user input is durably accepted; admission receipts prevent replay.
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

Pi's awaited `turn_end` boundary coalesces up to ten descriptions into an inspectable context-only custom reminder with `triggerTurn: false`. Normal prompt start also collects notices. No board post starts an idle turn, interrupts tools, or creates steering/follow-up inputs. Notification receipts are recorded only when the description is handed to Pi's public request stream after all context transformations. A reminder persisted after a final/terminated/aborted turn may remain unnotified until another genuine request. Persisted pending notices suppress duplicate staging; ordinary compaction retains external receipts and does not imply the model still remembers an entry. Direct messages and explicit steering remain necessary for assignments, urgent corrections and blocked-child wake-ups.

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
