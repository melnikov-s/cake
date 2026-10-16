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
and then updated by Events. Focused Project Session-related views and renderer
Models are projections; they are not additional authorities.

### Revision

An ordering marker within one observation boundary. Revisions detect ordering,
duplication, and loss; they are not global application versions.

## Sessions and conversations

### Pi Session

The Pi-owned conversation backing a materialized Cake Session. For regular Pi,
this is the transcript identified by `PiSessionId` and represented by Pi's session
files, with Pi-owned messages, tool history, branches, compaction, and format.
Permanent Cake Chat instead uses Pi Durable's SDK-owned SQLite originals and
checkpoints. The shared ownership term does not imply that Durable uses JSONL or
`SessionManager`; see [Pi backends](./cake-architecture.md#pi-backends).

### Pi Session Runtime

A live, scoped Pi resource operating on a Pi Session. It accepts prompts and
other runtime operations and emits live events. Releasing it does not delete
the Pi Session. Regular-Pi turns and queues have runtime lifetime; permanent Cake
Chat's persisted inbox and execution recovery follow the
[Durable storage contract](./cake-storage.md#permanent-cake-chat), not the regular-Pi lifetime.

### Conversation

The transcript-bearing concept presented by Cake. Every materialized Cake
Session has exactly one Conversation. Pi remains the durable authority for that
Conversation's messages, tool history, branches, compaction, and transcript
format. Cake projects purpose-built `ConversationSnapshot` and
`ConversationEvent` values; raw SDK objects stay inside `src/services/pi` or
`src/services/pi-durable`, according to the backend. Shared presentation does not
require identical history-loading or recovery mechanics.

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
and policy; Pi owns the Conversation transcript, durable by default or in-memory
for an explicitly ephemeral private worker.

### Project Session

The top-level, Project-associated Cake Session aggregate root that users open
from the sidebar. A Project Session **has one primary Conversation** and
coordinates or references its Project, Working Directory, lifecycle,
Discussion Sessions, Subagent Sessions, review threads, artifact links, and
Session Family membership. Those authorities remain focused: the aggregate
projection joins bounded references and summaries rather than copying Pi
transcripts, artifact payloads, Git state, or review storage into a god object.

A renderer that knows the Project Session target subscribes directly through
`conversations.observe`. Project, lifecycle, Review, Discussion, subagent,
artifact, Session Family, and scheduled-message facts remain in focused
authorities and renderer Models instead of being copied into a Project
Session-shaped payload. The renderer consumes these projections but does not
define Project Session ownership.

### Cake Chat Session

The one permanent application-level coordinator, with one independently observed Conversation,
a bounded OptChat summary view and a curated coordination-control projection.
Pi Durable owns its originals, persisted inbox, checkpoints, and recovery through
its SQLite adapter; this is intentionally different from regular Project Sessions.
It creates and manages independent Project task sessions, but cannot execute
shell/file/browser work itself. It is not a collection of global chats and has
no resolve/delete/rename/split lifecycle. Its renderer Store does not use a
Project Session-shaped snapshot and carries no Project, Working
Directory, review, artifact, Session Family, or schedule state. Project-aware
investigators use the existing focused Subagent activity authority and shared
Chat interface, not a new visible Project Session or parallel worker UI. Cake
Chat remains separate from Project Session catalogs. Side chats branched from its
messages are Discussion Sessions, not additional Cake Chat Sessions.

### Discussion Session

A lightweight Cake Session whose Conversation is anchored to a parent Project
Session's primary Conversation at session, assistant-message, review, or source
scope. Cake owns the anchor and regenerates read-only parent context; Pi owns
the Discussion Session's transcript. **Side chat** is UI copy only; domain code
uses **Discussion Session**.

The permanent Cake Chat can also parent Discussion Sessions, anchored to a whole
message or a selected passage. A Cake Chat side chat is a native fork of Cake Chat's
Durable conversation after the anchored exchange: it continues from Cake Chat's
exact context, separately from Cake Chat, and keeps its quick-check tools but not
Cake controls; the user returns to Cake Chat for actions. When Cake Chat cannot
fork there, the side chat is a tool-free branch whose context is the Cake Chat
text through the anchored message, captured once when it starts.

### Subagent Session

A private Cake Session **owned by a parent Cake Session**. Cake owns its stable
parent-scoped handle, fixed tool boundary, concurrency, retention, and visibility
policy. It is never a Project Session and does not expose its backing Pi Session
identity to the renderer. Cake Chat project investigators are bound to an explicit
registered project root, with normal project resources and investigation-only
permissions unless started with `allowMutations: true`, which permits scoped,
reported operational mutations. Project-free general researchers use isolated instructions without
repository resources and have only read/bash/message_parent. Both Cake Chat modes
end on explicit close, backend shutdown, or the first idle moment 30 minutes
after creation; turns have no time limit. Their Pi history is
in-memory; their parent retains only compact
receipts/reports and usage. Ordinary Project Session subagents keep their existing
private on-disk Pi history and explicit-delegation policy.

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

A reusable deliverable that the user benefits from opening, revisiting, or exporting
outside the conversation flow. Artifact status is an explicit product choice, not
something inferred from length, content kind, or syntax. An explicitly requested
text document, interactive visualization, or exportable data set may be an Artifact;
ordinary Markdown remains conversation content even when it contains Mermaid, a
small table, or another richly rendered block. Text/Markdown artifacts require an
explicit user request unless a spec serves as a shared, durable reference for the
session after compaction or for child sessions coordinating implementation.
Investigations, explanations, ordinary implementation details, progress, and reports
stay in chat by default. See [artifact product policy](./s4-artifact-protocol.md#product-boundary-and-presentation).

An Artifact is a global Cake-owned lineage of immutable full-snapshot revisions.
A lineage is **linked to**, never owned by, either a Cake Session or a Session
Family through explicit references. A link follows the latest revision or
pins one exact revision, without copying payload bytes or appending a Pi entry.
Any effectively linked session may publish the next revision with compare-and-swap
against the latest revision. Cake owns bounded payloads and lineage metadata; Pi
owns only transcript references to stable `cake://artifact/<lineage-id>` or exact
`cake://artifact/<lineage-id>@rN` refs.

### Interview

An independent structured-input workflow through which an active Pi tool call
waits for one validated user response or cancellation. An Interview is not an
Artifact: it has its own contracts, RPC, transcript metadata, and session-owned
Store instances, and never enters the artifact repository or panel. It may use
trusted fields or a sandboxed widget. See [interview ownership](./interviews.md).

### Blocking request

A transient reverse request to a renderer. Interviews are one kind; other kinds
include renderer queries and project-control interactions. The shared request
coordinator owns correlation and settlement, not each workflow's product state.

### Cake Session Runtime

Cake's scoped adapter around **exactly one Pi Session Runtime for exactly one
Cake Session**. It attaches the Cake Session kind's capabilities, hooks, and
projection policy without replacing Pi's execution machinery. The backing engine
is regular Pi or Pi Durable according to the Cake Session kind; this does not
create a second Cake-owned engine or transcript.

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
result is a snapshot, not a live binding to later preset edits. Agents omit the
model unless the user requests one. When a session launch (session, draft,
child, or workflow agent) omits the model, Cake snapshots the configured
default preset's complete settings; only when no default preset is configured
does it snapshot the calling session's current model, thinking level, and Fast
mode setting instead. Workflow runs take that snapshot once at run start. Project
Session subagents that omit the model resolve like session launches. A Cake
Chat subagent that omits the model follows the Cake Chat Subagent default model
setting (Settings → Cake Chat). Inherit (the out-of-the-box value) snapshots
Cake Chat's current model, thinking level, and Fast mode, using the default
preset only when there is no current model; Default behaves like a session
launch; Utility, a chosen preset, or a chosen model are used exactly and fail
clearly when unconfigured or deleted. Existing sessions, resumes, and forks keep their own configuration.

### Utility Model Preference

Cake's selected Model Preset for bounded, non-session work such as titles and
Managed Worktree names. Pi executes the resolved selection; Cake owns the
preference and feature policy.

### Non-chat Model Preference

Cake's optional backend-owned provider/model reference for image generation or
classification. Absence leaves selection to the agent. The preference is advisory,
not a restriction: an explicit requested reference takes precedence, and an
unavailable reference produces an explicit error rather than silent substitution.
Eligible Project Session codemode scripts resolve it through
`models.select-non-chat`, then execute through Pi's native `models` API. It never
changes chat presets or the utility model, enables tools, or starts background
classification or Auto routing.

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
subscriptions, successes, typed failures, and middleware across Electron IPC or
the network transport. Transport choice does not change domain authority.

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
implementations. Stores compose as stateful components: parents coordinate children
according to behavioral ownership and lifetime. Many small, isolated Stores can be
the appropriate model of a complex application. Count and depth are not quality
metrics; duplicated authority, leaked internals, and unrelated responsibilities are
the concerns. Composition does not require parents to forward each child's API.

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

A control surface durably bound to one Cake Session and mounted in a named
semantic slot whenever that session is shown. A Session Plugin is either a
first-party prebuilt control configured with validated state or generated React
for a genuinely custom need. Its definition, private JSON state, and
session-shared named JSON state survive turns, unmounting, window closure, and
application restart. A user-owned hidden preference is independent of
agent-managed state, so updates and replacement do not reopen a hidden plugin.

Generated Session Plugins execute in Cake's opaque-origin widget sandbox. The
host supplies live semantic theme tokens and owns the always-available Hide/Show
control. The host-bound `useCake()` capability invokes the owning session's
actual Cake operation registry; `usePluginState()` addresses the current
plugin's durable private state; and `useSharedState(key)` addresses durable named
state shared only among plugins in the same session. Ordinary React state such
as `useState` belongs only to one mounted iframe and resets on unmount. Session
Plugin data is removed on explicit plugin deletion or permanent deletion of the
owning Cake Session, not on hide, resolution, or runtime release.
