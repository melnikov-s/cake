# Cake architecture vocabulary

This document defines Cake's canonical architectural language. New contracts,
services, domain modules, Stores, Models, events, and documentation use these
terms consistently. Avoid the unqualified word `Session` where either Pi or
Cake ownership could be meant.

## Authority and state

### Authority

The system that owns a fact and can reconstruct it after Cake restarts. Every
durable fact has exactly one authority.

### Identity

A stable value that answers **which entity is this?** Identity survives runtime
release and projection replacement. `PiSessionId`, Cake Session IDs, Project
IDs, and artifact lineage IDs are identities. Identity is not a capability and
does not imply that an entity is currently materialized.

### Reference

A bounded value that identifies another independently owned entity, optionally
with routing or display metadata. A Reference does not transfer ownership and
must not copy the referenced entity's authoritative payload. Project Session
workflows join Discussion Session, Subagent Session, review-thread, artifact-link,
and Session Family references only at the focused surface that needs them.

### Handle

A scoped capability for operating one live resource. A Handle is neither an
identity nor persisted state. Releasing a Handle releases that capability lease;
it does not delete the entity.

### Runtime

Live execution machinery with a resource lifetime. A Runtime may be acquired
and released repeatedly for one durable identity. Runtime state is not a durable
transcript unless its authority explicitly persists it.

### Snapshot

A complete representation of current state at one point in an authoritative
sequence. A Snapshot describes one observation boundary and is not necessarily
persisted by Cake.

### Event

One typed occurrence after a snapshot. Events report state transitions or
runtime activity.

### Update

An item emitted by an observation Stream. An update is either an initial
snapshot or a subsequent event.

```ts
type Update<Snapshot, Event> =
  | { readonly _tag: "Snapshot"; readonly snapshot: Snapshot }
  | { readonly _tag: "Event"; readonly event: Event };
```

### Projection

A purpose-built, validated, derived representation assembled from one or more
authorities for a consumer. A Projection may itself be delivered as a Snapshot
and then updated by Events. Project Session overviews and renderer Models are
projections; they are not additional authorities.

### Revision

An ordering marker within one observation boundary. Revisions detect ordering,
duplication, and loss; they are not global application versions.

## Sessions and conversations

### Pi Session

A Pi-owned durable transcript identified by `PiSessionId` and represented by
Pi's session files. Pi owns its messages, tool history, branches, compaction,
and transcript format.

### Pi Session Runtime

A live, scoped Pi resource operating on a Pi Session. It accepts prompts and
other runtime operations and emits live events. Releasing it does not delete
the Pi Session.

### Conversation

The transcript-bearing concept presented by Cake. Every materialized Cake
Session has exactly one Conversation. Pi remains the durable authority for that
Conversation's messages, tool history, branches, compaction, and transcript
format. Cake projects purpose-built `ConversationSnapshot` and
`ConversationEvent` values; raw Pi trees and messages never leave
`src/services/pi`.

A Conversation is not a Cake Session: it does not own Project routing,
lifecycle, relationships, review threads, or artifact links. A staged, unsent
chat is renderer state and is neither a Conversation nor a Cake Session.

### Cake Session

The abstract Cake domain entity for one conversational session:

```ts
type CakeSession = ProjectSession | CakeChatSession | DiscussionSession | SubagentSession;
```

Every materialized Cake Session has exactly one Conversation backed by exactly
one Pi Session. Cake owns the kind-specific identity, metadata, relationships,
and policy; Pi owns the durable Conversation transcript.

### Project Session

The top-level, Project-associated Cake Session aggregate root that users open
from the sidebar. A Project Session **has one primary Conversation** and
coordinates or references its Project, Working Directory, lifecycle,
Discussion Sessions, Subagent Sessions, review threads, artifact links, and
Session Family membership. Those authorities remain focused: the aggregate
projection joins bounded references and summaries rather than copying Pi
transcripts, artifact payloads, Git state, or review storage into a god object.

The main/domain layer assembles `ProjectSessionProjection` only as a fresh,
on-demand overview/header read. It identifies the primary Conversation by a
bounded `ConversationReference`; it never embeds `ConversationSnapshot` or
copies relationship catalogs. A renderer that already knows the Project
Session target subscribes directly through `conversations.observe` without
waiting for that optional overview. Review, Discussion, subagent, artifact,
Session Family, and scheduled-message payloads remain in focused authorities
and renderer Models. The renderer consumes these projections but does not
define Project Session ownership.

### Cake Chat Session

An application-level Cake Session with one independently observed Conversation
and a focused curated Cake-control request projection. Its renderer Store does
not use a Project Session-shaped snapshot and carries no Project, Working
Directory, review, subagent, artifact, Session Family, or schedule state. It
remains separate from Project Session catalogs.

### Discussion Session

A lightweight Cake Session whose Conversation is anchored to a parent Project
Session's primary Conversation at session, assistant-message, review, or source
scope. Cake owns the anchor and regenerates read-only parent context; Pi owns
the Discussion Session's transcript. **Side chat** is UI copy only; domain code
uses **Discussion Session**.

### Subagent Session

A private Cake Session **owned by a parent Cake Session**. Cake owns its stable
parent-scoped handle, fixed tool boundary, concurrency, retention, and visibility
policy. It is never a Project Session and does not expose its backing Pi Session
identity to the renderer.

### Session Family

A durable Cake-owned, recursively nested relationship among independent Project
Sessions. A Session Family has one root; every non-root member has exactly one
immediate parent, and each parent's direct children retain stable creation order.
Every member remains an independent Pi Session with its own transcript, runtime,
context, model configuration, and fixed Working Directory. Family identity and
membership are not Pi transcript ancestry. Only the root owns resolution;
every child inherits its immediate parent's resolution recursively. Transcript
placement and renderer projections do not give children independent lifecycle state.

### Coordination Thread

A lightweight Cake-owned binding between two Cake Sessions. It owns participant
routing, correlated message IDs, optional message limits, delivery projection,
and closure state. It does not own or copy either Pi transcript, and it never
implies autonomous delegation.

### Turn

One user request and the resulting agent activity until it settles.

### Message

A durable transcript entry in a Pi Session. Streaming parts update a Message;
they are not separate Messages. A cross-session message remains an ordinary Pi
user Message carrying validated Cake coordination metadata; its Cake message ID
correlates delivery state but is not a second transcript identity. Its explicit
response expectation says whether stopping without a correlated reply requires a
sender notice; informational messages and generated notices create no response
obligation.

### Artifact

A substantial, reusable deliverable that the user benefits from opening, revisiting,
or exporting outside the conversation flow. Artifact status is an explicit product
choice, not something inferred from a content kind or syntax. A long-form document,
interactive visualization, or exportable data set may be an Artifact; ordinary
Markdown remains conversation content even when it contains Mermaid, a small table,
or another richly rendered block.

An Artifact is a global Cake-owned lineage of immutable full-snapshot revisions.
A lineage is **linked to**, never owned by, either a Cake Session or a Session
Family through explicit references. A link follows the latest revision or
pins one exact revision, without copying payload bytes or appending a Pi entry.
Any effectively linked session may publish the next revision with compare-and-swap
against the latest revision. Cake owns bounded payloads and lineage metadata; Pi
owns only transcript references to stable `cake://artifact/<lineage-id>` or exact
`cake://artifact/<lineage-id>@rN` refs.

### Blocking request

A transient, inline interaction through which an active tool call waits for one
validated user response or cancellation. A blocking request is not an Artifact
and is never stored in the reusable artifact catalog, even when it reuses snapshot
schemas, rendering, or sandbox infrastructure.

### Cake Session Runtime

Cake's scoped adapter around **exactly one Pi Session Runtime for exactly one
Cake Session**. It attaches the Cake Session kind's capabilities, hooks, and
projection policy without replacing Pi's execution machinery.

### Cake Session Handle

The scoped Handle for one Cake Session Runtime. It exposes Cake-owned operations
and a Conversation observation Stream for the lifetime of its Effect Scope.

## Projects and filesystems

### Project

A directory registered with Cake and identified by `ProjectId`. A Project does
not have to be a Git repository.

### Repository

A Git repository discovered by the `Git` service. Git owns repository facts.

### Working Directory

The actual directory in which a Project Session and its tools operate. A
Project Session may use the Project root or a Managed Worktree path.

Use `workingDirectory` in new architecture and contracts. Avoid the ambiguous
bare term `workspace`, which Pi, VS Code, Git, and Cake use differently.

### Git Worktree

A worktree reported by Git, including its path, branch, and head. Git owns
whether it exists and its repository state.

### Managed Worktree

Cake-owned metadata and lifecycle policy around a Git Worktree. Cake records
why it exists and which Project or Project Session uses it; Git remains the
authority for the checkout itself.

## Models and model selection

### Pi Model Reference

The stable provider and model identifiers of a model known through Pi. The
reference may remain stored while unavailable.

### Model Selection

A concrete Pi Model Reference plus the Pi thinking level and other supported
execution settings, ready for Pi to use.

### Model Preset

A named Cake-owned configuration that resolves to a Model Selection. Cake
preserves an unresolved preset and reports its state rather than silently
substituting another model.

Public Cake operations accept a model as either a configured preset name or an
explicit provider, model ID, thinking level, and optional Fast mode setting. A
string always names a preset; it is never interpreted as a raw model ID. Cake
resolves a preset from authoritative application configuration when the
operation executes and passes the resulting concrete selection to Pi. The
result is a snapshot, not a live binding to later preset edits. When a creation
operation documents model inheritance, omitting the model snapshots the calling
session's current model, thinking level, and Fast mode setting instead.

### Utility Model Preference

Cake's selected Model Preset for bounded, non-session work such as titles and
Managed Worktree names. Pi executes the resolved selection; Cake owns the
preference and feature policy.

Use Pi's term **thinking level**, not `reasoning level`, in new contracts.

## Effect architecture

### Service

An Effect Context capability that touches or represents the outside world.
Examples are Pi, Git, the filesystem, storage, Electron, VS Code Server, a PTY and the IPC boundary. A service has Effectful methods
and may own scoped resources.

A service may represent a deliberate concrete dependency such as VS Code
Server; it does not need to be a generic abstraction intended for swapping.

### Live Layer

The production Effect Layer that implements a Service. Test Layers provide the
same Service contract with controlled behavior.

### Domain module

A cohesive module of Cake business logic. It exports free Effect operations
that combine Services and enforce Cake policy. A domain module is not an Effect
Context service.

### Domain operation

A named, free Effect function exported by a domain module, usually created with
`Effect.fn`. It may yield any Services it needs.

### RPC protocol

The shared Effect RPC group and Effect Schemas defining commands, queries,
subscriptions, successes, typed failures, and middleware across the Electron
process boundary.

### Query

An RPC that reads current information without requesting a state transition.

### Command

An RPC that requests a state-changing operation.

### Subscription

A streaming RPC whose lifetime is scoped to its consumer and renderer
connection.

## Renderer architecture

### Renderer application state

Window-local state needed to operate Cake's UI: selection, loaded surfaces,
pending operations, drafts, loading and failure states, panel state, and
workflow coordination.

### Renderer Client

A renderer-local, typed Promise API grouped by semantic Cake capability. It is
the imperative adapter over the window's generated Effect RPC client and
runtime. It propagates `AbortSignal` cancellation into Effect interruption and
hides Layers, Fibers, transport envelopes, and RPC implementation details from
Stores and React.

### Model observer

The renderer's single window-owned Stream-to-Model boundary. It listens to
current-first Effect RPC Streams, applies authoritative snapshots with
`applySnapshot`, and reduces subsequent validated Events transactionally. It
uses direct, batched Model mutations for incremental entity changes. It owns Model observation demand and each observation's cancellation handle.
The renderer runtime's narrow Stream helper handles interruption and retries
that Stream with an Effect Schedule. The observer trusts each source's
current-first, ordered update contract rather
than implementing a second revision protocol. Renderer bootstrap attaches it
to the mounted Root Store so it can reactively discover current loaded Models;
feature Stores and Models never access the observer.

### Window state persistence

Window-owned renderer infrastructure that loads one versioned r-state-tree Store
snapshot before the Root Store mounts, then observes snapshots from the mounted
Store tree and saves them through `Client`. It is not a Store, does not
participate in Store Context, and never reapplies storage to a mounted Store.

### Store

An r-state-tree behavioral component owning window-local renderer application
state, application/UI logic, workflow operations, cancellation, and concurrency
policy. Stores read Models and invoke `Client`; they do not
consume Effect directly or contain Cake business rules or privileged
implementations.

### Model

An r-state-tree reactive representation of a validated entity such as a
Project, Cake Session, Message, Artifact, or Review Thread. Models represent
current projected state and synchronous invariants. Models know nothing about
Streams, RPC, revisions, reconnects, or synchronization; the Model observer
populates them through snapshots, and Stores and React read them reactively.

### React-local state

Focus, measurement, hover, animation, browser selection, and isolated input
state whose lifetime is one component. Shared workflow state does not belong
here.

## Extensibility

### Pi Extension

Executable code loaded by Pi and bound to a Pi Session Runtime. Its executable
lifecycle belongs to `CakeSessionRuntimes`; discovery and diagnostics belong to
`PiAgentResources`.

### Session Plugin

A generated React control surface durably bound to one Cake Session and mounted
in a named semantic slot whenever that session is shown. Its definition,
generated source, private JSON state, and session-shared named JSON state survive
turns, unmounting, window closure, and application restart. Ordinary React state
such as `useState` belongs only to one mounted iframe and resets on unmount.

Session Plugins execute in Cake's opaque-origin widget sandbox. The host-bound
`useCake()` capability invokes the owning session's actual Cake operation
registry; `usePluginState()` addresses the current plugin's durable private
state; and `useSharedState(key)` addresses durable named state shared only among
plugins in the same session. Session Plugin data is removed on explicit plugin
deletion or permanent deletion of the owning Cake Session, not on resolution or
runtime release.
