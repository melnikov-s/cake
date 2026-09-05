# Cake architecture vocabulary

This document defines Cake's canonical architectural language. New contracts,
services, domain modules, Stores, Models, events, and documentation use these
terms consistently. Avoid the unqualified word `Session` where either Pi or
Cake ownership could be meant.

## Authority and state

### Authority

The system that owns a fact and can reconstruct it after Cake restarts. Every
durable fact has exactly one authority.

### Snapshot

A complete representation of current state at a point in an authoritative
sequence. A snapshot is not necessarily persisted by Cake.

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

A current, derived representation of authoritative state. Renderer Models are
reactive projections; they are not additional authorities.

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

### Cake Session

Cake's semantic use of a Pi Session. `CakeSession` is the umbrella domain type:

```ts
type CakeSession = ProjectSession | CakeChatSession | DiscussionSession | SubagentSession;
```

Every materialized Cake Session is backed by a Pi Session, but Cake owns its
kind-specific metadata and policy. A staged, unsent chat is renderer state and
is not yet a Cake Session or Pi Session.

### Project Session

A Cake Session associated with a Project and a Working Directory. This is the
normal user-facing coding session.

### Cake Chat Session

An application-level Cake Session with curated Cake controls. It remains
separate from Project Session catalogs.

### Discussion Session

A Cake Session anchored to an assistant message, review, or source location.
Cake owns the anchor; Pi owns the sidecar transcript. It receives regenerated,
read-only parent context and constrained capabilities.

### Subagent Session

A private child Cake Session owned by another Cake Session. Cake owns its
stable handle, capability profile, concurrency, recursion, retention, and
visibility policy. It is never a Project Session and does not expose its
backing Pi Session identity to the renderer.

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
correlates delivery state but is not a second transcript identity.

### Session handle

A scoped capability for one live session runtime. A handle is not identity or
persistence; it is access to operations and an observation Stream for the
lifetime of its Scope.

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

### Model synchronizer

The renderer's single window-owned Stream-to-Model boundary. It listens to
current-first Effect RPC Streams, applies authoritative snapshots with
`applySnapshot`, and reduces subsequent validated Events transactionally. It
uses direct, batched Model mutations for incremental entity changes. It owns
subscription, revision, reconnect, and interruption
mechanics. Renderer bootstrap attaches it
to the mounted Root Store so it can reactively discover current loaded Models;
feature Stores and Models never access the synchronizer.

### Window state persistence

Window-owned renderer infrastructure that loads one versioned r-state-tree Store
snapshot before the Root Store mounts, then observes snapshots from the mounted
Store tree and saves them through `RendererClient`. It is not a Store, does not
participate in Store Context, and never reapplies storage to a mounted Store.

### Store

An r-state-tree behavioral component owning window-local renderer application
state, application/UI logic, workflow operations, cancellation, and concurrency
policy. Stores read Models and invoke `RendererClient`; they do not
consume Effect directly or contain Cake business rules or privileged
implementations.

### Model

An r-state-tree reactive representation of a validated entity such as a
Project, Cake Session, Message, Artifact, or Review Thread. Models represent
current projected state and synchronous invariants. Models know nothing about
Streams, RPC, revisions, reconnects, or synchronization; the Model synchronizer
populates them through snapshots, and Stores and React read them reactively.

### React-local state

Focus, measurement, hover, animation, browser selection, and isolated input
state whose lifetime is one component. Shared workflow state does not belong
here.

## Extensibility

### Pi Extension

Executable code loaded by Pi and bound to a Pi Session Runtime. Its executable
lifecycle belongs to `PiSessions`; discovery and diagnostics belong to
`PiAgentResources`.
