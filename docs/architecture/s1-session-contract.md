# S1 Project Session and Conversation contract

A **Cake Session** is the abstract Cake domain entity for one conversational
session. Its concrete kinds are Project Session, Cake Chat Session, Discussion
Session, and Subagent Session. Every materialized Cake Session has exactly one
**Conversation** backed by exactly one Pi Session; Pi remains the durable
transcript authority.

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

| State                                                                      | Authority                        | Owner, lifetime, persistence, and concurrency                                                          |
| -------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Conversation transcript, tool results, model history, branches, compaction | Pi                               | Pi Session JSONL; serialized by Pi; Cake projects only purpose-built snapshots and events              |
| Pi provider credentials and resources                                      | Pi                               | Pi storage/runtime; secrets never enter Cake projections                                               |
| Active turn and transient Pi queues                                        | Pi Session Runtime               | Runtime lifetime; turn admission follows Pi/Cake per-session serialization policy                      |
| Cake Session kind, Project and Working Directory references, lifecycle     | Cake domain/storage              | Durable where declared by focused storage; lifecycle transitions serialize per authority               |
| Discussion anchors and review-thread metadata                              | Cake review/discussion authority | Durable focused records; Discussion Session transcripts remain in their own Pi Sessions                |
| Subagent ownership and activity                                            | Cake subagent coordinator        | Parent Cake Session-owned; process/runtime lifetime and bounded concurrency                            |
| Artifact lineage and payload                                               | Cake artifact repository         | Globally durable; Project Sessions and Session Families hold links, never ownership or copied payloads |
| Session Family membership                                                  | Cake Session Family storage      | Durable relation among independent Project Sessions; root owns family lifecycle                        |
| `ProjectSessionProjection`                                                 | Main/domain assembly             | Fresh on-demand overview; no independent persistence, stream, relationship catalog, or write authority |
| Renderer Models and Stores                                                 | Renderer window                  | Focused validated projections plus UI/workflow state; Models/Stores do not define the aggregate        |

## Main-owned on-demand overview

`ProjectSessionProjection` is an Effect Schema owned by
`src/domain/project-sessions`. Main assembles it as an optional current overview
containing the Project Session identity, Project and Working Directory
references, lifecycle, and exactly one
`primaryConversation: ConversationReference`. It never embeds the Conversation
or duplicates Discussion, Subagent, review, artifact-link, or Session Family
catalogs.

The `projectSessions.readProjection` Effect RPC success Schema validates this
overview across the main-to-renderer boundary. It is a fresh query, not a live
renderer synchronization source. An already-known Project Session target starts
its independent Conversation subscription immediately. Focused authorities
populate their own Models, and `ProjectSessionStore` coordinates their Stores
without owning or re-exporting the payloads.

| Projection field      | Authority and owner                                                           | Lifetime / persistence                                            | Concurrency policy                                                |
| --------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `identity`            | Cake Project Session routing identity                                         | Durable focused routing metadata; projection lifetime in renderer | Identity collisions reject the projection                         |
| `project`             | Cake Project registry                                                         | Durable Project record; referenced by projection                  | Project mutations serialize in the Project authority              |
| `workingDirectory`    | Cake routing plus Managed Worktree reference; Git owns checkout facts         | Durable routing/worktree metadata; no copied filesystem state     | Managed Worktree operations use their repository/worktree queues  |
| `lifecycle`           | Project Session lifecycle / family-root authority                             | Durable active/archive placement and unread metadata              | Lifecycle transitions serialize under standalone/family authority |
| `primaryConversation` | Project Session-to-Conversation relation; transcript remains Pi-authoritative | Overview-read lifetime; bounded identity reference only           | Relation is fixed for the materialized Project Session            |

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

A known Project Session target starts Conversation observation without first
reading `ProjectSessionProjection`. Focused Discussion, Subagent,
scheduled-message, review, artifact, family, and catalog sources update only
their own Models. None of those updates triggers an overview reread or replaces
the Conversation projection.

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

## Verification boundary

Focused integration tests cover the fresh overview read, Effect Schema
round-tripping across its main-to-renderer RPC
contract, Pi JSONL reopen, complete active-branch Conversation projection,
snapshot/event ordering, renderer hydration, stale-identity rejection,
cancellation, and the Electron RPC boundary. Provider-backed calls remain opt-in.
