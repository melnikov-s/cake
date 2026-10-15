# S1 Project Session and Conversation contract

A **Cake Session** is the abstract Cake domain entity for one conversational
session. Its concrete kinds are Project Session, Cake Chat Session, Discussion
Session, and Subagent Session. Every materialized Cake Session has exactly one
**Conversation** backed by exactly one Pi Session; Pi remains the durable
transcript authority. This common ownership does not imply one storage engine:
Project and regular-Pi auxiliary sessions use coding-agent session files, while
the permanent coordinator uses [Pi Durable](./cake-storage.md#permanent-cake-chat).
The JSONL, branching, queue, and lifecycle details below describe Project Sessions,
not a replacement contract for that coordinator.

A **Project Session** is the top-level Project-associated aggregate root users
open from the sidebar. It has one primary Conversation and coordinates or
references its Project, Working Directory, lifecycle, Discussion Sessions,
Subagent Sessions, review threads, artifact links, and Session Family
membership. Related authorities stay separate: renderer workflows compose their focused
projections without copying Pi transcripts, artifact payloads, Git state, or
review records into a giant persisted object.

## Identity, references, capabilities, and observations

- **Identity** says which durable entity is meant. It is not a live capability.
- A **Reference** identifies an independently owned related entity and may carry
  bounded routing or display metadata. References do not transfer ownership.
- A **Pi Session Runtime** is Pi's live execution machinery.
- A **Cake Session Runtime** is Cake's scoped adapter around exactly one Pi
  Session Runtime for exactly one Cake Session. It attaches the kind-specific
  capability profile, hooks, and Conversation projection policy.
- A **Cake Session Handle** is the scoped capability for that Cake Session
  Runtime. Releasing it does not delete the Cake Session or Pi transcript.
- A **Snapshot** is complete current state for one observation boundary at one
  sequence point.
- A **Projection** is a purpose-built, validated derived view. A Projection may
  be delivered in a Snapshot and updated by Events; it is not another authority.

`CakeSessionRuntimes` is therefore the precise Service name. The former
`PiSessions` name was misleading because acquisition returns Cake's scoped
adapter and Cake Session Handle, not a raw Pi runtime. Genuine Pi-owned query,
target, preview, error, and persistence concepts remain `PiSession*` values.

## Authority and lifecycle

| State                                                                              | Authority                        | Owner, lifetime, persistence, and concurrency                                                          |
| ---------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Project Conversation transcript, tool results, model history, branches, compaction | Pi                               | Pi Session JSONL; serialized by Pi; Cake projects only purpose-built snapshots and events              |
| Pi provider credentials and resources                                              | Pi                               | Pi storage/runtime; secrets never enter Cake projections                                               |
| Project active turn and transient Pi queues                                        | Pi Session Runtime               | Runtime lifetime; turn admission follows Pi/Cake per-session serialization policy                      |
| Cake Session kind, Project and Working Directory references, lifecycle             | Cake domain/storage              | Durable where declared by focused storage; lifecycle transitions serialize per authority               |
| Discussion anchors and review-thread metadata                                      | Cake review/discussion authority | Durable focused records; Discussion Session transcripts remain in their own Pi Sessions                |
| Subagent ownership and activity                                                    | Cake subagent coordinator        | Parent Cake Session-owned; process/runtime lifetime and bounded concurrency                            |
| Artifact lineage and payload                                                       | Cake artifact repository         | Globally durable; Project Sessions and Session Families hold links, never ownership or copied payloads |
| Session Family membership                                                          | Cake Session Family storage      | Durable relation among independent Project Sessions; root owns family lifecycle                        |
| Renderer Models and Stores                                                         | Renderer window                  | Focused validated projections plus UI/workflow state; Models/Stores do not define the aggregate        |

## Conversation observation

A Conversation observation emits one coherent `ConversationSnapshot` followed
without a gap by ordered `ConversationEvent` values. Raw Pi messages, trees, and
SDK event objects stop below `src/services/pi`; Cake maps them before domain or
RPC code sees them. Reconnect obtains a new authoritative snapshot. Cake never
tails Pi JSONL or persists a duplicate transcript/event log.

The validated `conversations.observe` RPC carries only `ConversationUpdate`:
one `ConversationSnapshot` followed by ordered `ConversationEvent` values. It
updates the stable renderer `Conversation` Model and contains no Project,
Working Directory, lifecycle, Discussion, Subagent, scheduled-message, review,
artifact, family, or Cake-control payload.

A known Project Session target starts Conversation observation directly.
Focused Discussion, Subagent, scheduled-message, review, artifact, family,
lifecycle, Project, and catalog sources update only their own Models. None of
those updates rebuilds a Project Session-shaped payload or replaces the
Conversation projection.

The lightweight Project Session catalog projects active Pi work, including prompt
preparation before streaming starts, but not queued follow-ups or turn correlations
retained after Pi settles. Pi activity transitions and acceptance/settlement events
refresh sidebar indicators without demanding a Conversation observation or selecting
the session. These activity events also carry the transcript's last write time (one
file stat, never a transcript read), so sidebar recency follows background turns.
Activity is runtime-derived and is not persisted as session metadata.
Conversation activity likewise clears when Pi stops, independently of later turn
completion bookkeeping.

## Relationship language

- A Project Session **has a primary Conversation**.
- A Discussion Session **is anchored to** that primary Conversation; “side
  chat” is UI copy, not domain language.
- A Subagent Session **is owned by a parent Cake Session**.
- An Artifact lineage **is linked to** a Cake Session or Session Family; it is
  not owned by either.
- A Session Family **relates independent Project Sessions**. Membership is not
  Pi transcript ancestry and does not merge Conversations.

## Commands, trust, and renderer ownership

Project Session commands execute as main-process domain operations through
Effect RPC. Prompt returns an accepted Turn ID; delivery, steer, follow-up,
abort, compaction, fork, rename, resolve, and restore preserve typed failures
and cancellation. Scope ownership and repeated-call concurrency policy remain
separate decisions.

Main validates Project and Working Directory access before trusted Pi resources
load. Raw Pi and AI SDK values never cross RPC. The window-owned Model observer
applies validated Conversation snapshots and ordered events to stable
`Conversation` Models. It does not flatten focused authorities into those
Models. `ProjectSessionStore` owns renderer workflow and presentation
around the focused projections; Stores invoke the Promise `Client` and do not
import Effect, RPC contracts, main domain modules, or `CakeSessionRuntimes`.

## Batch session messaging

`sessions.send` remains a single-recipient operation. The separate Cake operation
`sessions.send-batch` accepts `sessionIds` (1–100 unique Project Session IDs), one
shared `text`, and shared optional `delivery`, `expectsResponse` (default false),
and `maxMessages`. It is registered in Project Session and global Cake Chat
operation registries wherever single-send is available.

The operation adapter invokes the existing single-send path sequentially in
input order, preserving trusted routing, family response tracking, Pi admission,
and per-recipient delivery receipts. Omitted delivery starts idle recipients or
queues behind active work; explicit `steer` redirects active recipients. Each
recipient starts an independent exchange; `maxMessages` applies to each exchange.
Existing thread IDs, reply IDs, and task-input attachments are intentionally not
batch options; use single-send for those cases.

Schema-invalid arguments, empty recipient lists, or duplicate IDs reject the
whole call before delivery. Unknown targets and delivery failures instead produce
individual outcomes and do not stop later recipients. The result never echoes
shared text and contains one ordered outcome per input ID, with correlation IDs,
actual delivery/status on success, or a bounded error on failure. All outcomes
remain present in both structured results and model-facing text. Top-level `ok`
means processing completed; `status` is `complete`, `partial`, or `failed` according
to recipient successes. Inspect every outcome rather than treating `ok` as
all-recipient success.

Batch processing has tool-call lifetime and no independent persistence or queue.
Cancellation stops new attempts and marks remaining recipients `not-sent`, while
retaining prior outcomes if the tool result can still be returned. Transport
failure can leave an attempted delivery uncertain. Accepted deliveries are not
rolled back; there are no automatic retries. Check uncertain recipients before
retrying only selected failures, never replay the entire batch blindly. Receipts
are informational and require no acknowledgment.

## Resolution outcomes

Resolution commits Cake's authoritative lifecycle state before eligible checkout
cleanup. Cleanup failure does not roll that transition back. The command contract
distinguishes:

- `ResolutionRejected`: a known policy refusal before commit, with affected session
  IDs and an explanatory message. Arbitrary storage or transport failures are not
  reclassified as policy refusals.
- Ordinary success: single-session resolution still returns void.
- `ResolutionCleanupFailed`: resolution committed, with authoritative
  `resolvedSessionIds` and the observed `cleanupFailures`, each identifying its
  Working Directory. Existing cleanup order and stop behavior remain unchanged;
  the error does not assert that every other checkout was cleaned.

RPC and the validated Promise Client preserve these tagged distinctions for
application handling. A fork's existing `resolveSource` step preserves the same
lifecycle errors: they describe source resolution, not whether the preceding
fork creation occurred. They do not authorize automatic replay of the fork.
Renderer retirement/navigation treats committed resolution
as successful while presenting cleanup diagnostics, without inventing projection
state or guessing from an error message. Generic operational errors and lost
transport receipts remain potentially uncertain; callers do not automatically
replay commands.

Working Directory batch resolution keeps committed IDs in `resolvedSessionIds`,
including IDs whose follow-up cleanup failed. It reports `cleanupFailures`
separately from ordinary per-target `failures`; renderer workflows retire the
committed IDs and present both failure lists. Restore behavior is unchanged.
Merge-and-resolve consumes this same outcome contract; see
[worktree ownership and partial completion](./effect-architecture.md#filesystem-git-worktrees-vs-code-and-terminals).
The [implementation record](../proposals/backend-workflow-refinement.md) tracks
cutover and verification of this accepted contract.

## Verification boundary

Focused integration tests cover Pi JSONL reopen, complete active-branch
Conversation projection, snapshot/event ordering, renderer hydration,
stale-identity rejection, cancellation, and the Electron RPC boundary.
Provider-backed calls remain opt-in.
