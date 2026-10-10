# Cake architecture and product model

This document defines Cake's boundaries, ownership, and invariants. It is not a
feature catalog or roadmap. Read feature behavior only when the task touches it;
[focused references](#focused-references) route to those contracts and tests.
[The vocabulary](./cake-vocabulary.md) defines canonical terms;
[Effect architecture](./effect-architecture.md) defines runtime implementation
rules.

## Product identity

Cake is Pi expressed as a desktop GUI. Pi owns the coding-agent engine: providers,
models, agent loops, tools, extensions, skills, branching, compaction, and durable
session history. Cake supplies application navigation and web-native interaction
without replacing that engine. It may wrap Pi's public provider stream at the
adapter boundary for an explicit Cake-owned policy; it must not patch Pi internals.

A Project Session is the top-level project-associated aggregate with one primary
Conversation backed by one Pi Session. It coordinates bounded references to
independently owned related entities, not copies of their payloads. The application
also manages the user's collection of Projects and Cake Sessions. Cake Chat is a
separate Pi-backed application coordinator, not a transcript authority for Project
Sessions.

The conversation remains primary. Files, reviews, Draw boards, and artifacts
support the work rather than turning Cake into a general-purpose IDE. Embedded
VS Code owns source browsing, editing, Source Control, and native Git diffs.

## Sources of truth

Every durable fact has exactly one authority. Identity, runtime lifetime, and
projection lifetime are distinct.

| Concern                                                                  | Authority                                   | Cake's boundary                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Conversation messages, tool history, branches, compaction, session names | Pi Session files and `SessionManager`       | Project validated Conversation values; never persist a second transcript          |
| Models, providers, authentication, Pi settings and resources             | Pi                                          | Expose controls through the Pi adapter                                            |
| Model presets and utility/non-chat preferences                           | Cake application storage                    | Resolve explicit selections through Pi; never silently substitute a model         |
| Projects, workflow statuses, routing, Managed Worktree policy            | Cake                                        | Store metadata, not copies of Git or Pi state                                     |
| Checkouts, branches, working-tree changes                                | Git                                         | Coordinate lifecycle; VS Code presents live changes                               |
| Session Family membership, order, Working Directory bindings, resolution | Cake                                        | Members keep independent Pi transcripts; only the root owns family resolution     |
| Cross-session coordination                                               | Cake                                        | Own routing, correlation, and closure, not message text                           |
| Discussion/review scope and anchors                                      | Cake                                        | Replies remain in independent Pi sidecar sessions                                 |
| Pending scheduled delivery                                               | Cake                                        | Own cancellable intent until Pi accepts the ordinary message                      |
| Draw boards                                                              | Cake main-owned board storage               | Excalidraw owns the editable document; no second graph or transcript              |
| Artifacts                                                                | Cake global lineage repository              | Immutable revisions with explicit session/family links; caches are disposable     |
| Session Plugins                                                          | Cake application metadata and JSON state    | Session-bound controls with user-owned visibility                                 |
| Window selection, layout, drafts, workflow presentation                  | Cake renderer/window storage                | Presentation state is separate from domain facts                                  |
| Interviews                                                               | Active Pi tool call and interview contracts | One validated response or cancellation; session-owned form state, not an artifact |

Do not mutate Pi JSONL with ad hoc file operations, reconstruct Pi state into a
competing domain model, or make a Project Session-shaped shadow payload. Main
keeps related facts in focused authorities. The renderer joins only the
projections needed by a surface. References do not transfer ownership.

### Conversation invariants

- Every materialized Cake Session has exactly one Conversation backed by exactly
  one Pi Session. Releasing a runtime or observation does not delete it.
- Display history is the complete active branch from `SessionManager.getBranch()`,
  not compacted model input from `buildContextEntries()`.
- Model-facing reminders and custom messages remain inspectable, regardless of
  Pi's `display` flag; expose the live system prompt too. Presentation does not
  create another transcript authority.
- Tool Compact replays only user-authored input and assistant text. Strip injected
  reminders (including embedded ones), reasoning, tools, custom messages, and
  cross-session coordination. Keep orientation/provenance in non-context Pi
  metadata and the original transcript tree inspectable.
- Waiting user and cross-session inputs share Pi's runtime queue. Cake projects
  transient queue metadata; it does not persist a competing message queue.
- Sidecar discussions and private subagents have independent Pi transcripts.
  Parent anchors, handles, and projections do not merge transcript ownership.

### Lifecycle invariants

- Session identity is independent of its Working Directory and renderer selection.
  Git checkout existence is not Session identity or resolution state.
- Resolution is Cake metadata, not transcript relocation. Family children inherit
  their root's resolution; they have no independent resolution authority.
- A session cannot be archived while its Pi turn is active. An agent's own
  resolution request is deferred until the settled-turn boundary, after the final
  transcript snapshot.
- Git landing and Session resolution are separate actions. Sessions sharing a
  Working Directory share its lifecycle controls and terminals; resolving one
  must not retire a checkout still used by another active Session.
- Private Subagent Sessions are not selectable Project Sessions or Session Family
  children. Project agents use private delegation only on explicit user request.
- Automatic Project Session result handoff belongs to actual family parent-child assignments
  and independent sessions spawned by permanent Cake Chat, not arbitrary independent creators.
  Requester provenance and the pending delivery journal are Cake metadata; Pi remains transcript
  and run authority. See [spawned-session reporting](../development/spawned-session-reporting.md).

## Process boundaries

Cake is one logical application with privilege-separated hosts. Electron main and
each renderer have separate process-local Effect runtimes joined by Effect RPC.
The same backend graph can run in a standalone Node host; endpoints consume that
backend rather than acquiring duplicate Pi runtimes or storage authorities.

### Backend and Electron main

The backend owns Pi runtime lifecycle, filesystem access, application persistence,
privileged Services, and domain operations. Electron adds native windows and device
capabilities. Remote Electron acquires native capabilities, not a shadow backend.
A missing native capability fails explicitly; accepted backend work survives client
disconnection.

`src/services/pi` is the Pi integration boundary. `CakeSessionRuntimes`, `PiModels`,
and `PiAgentResources` expose focused Cake capabilities. Each Cake Session Runtime
wraps exactly one Pi Session Runtime and returns a scoped Handle. Raw Pi objects
and events stop at this boundary. Legacy focused adapters may remain in `src/agent`
during migration, but no new Pi integration belongs there.

### Preload and transport

Preload exposes only the frozen, validated Effect RPC transport. It exposes no raw
`ipcRenderer`, Node, general Electron capabilities, or Cake business logic.

Cross-process requests, successes, typed failures, and Stream elements are untrusted
until parsed by shared runtime Schemas at the receiving boundary. Services, Layers,
Scopes, Fibers, Stores, and Models never cross that boundary. RPC handlers adapt to
domain operations; they do not own business policy.

One process-scoped renderer-request coordinator owns transient reverse-request
correlation, targeting, cancellation, and cleanup through the existing RPC and
native-event Streams. A renderer-owned mutation must complete persistence and
acknowledge before the invoking tool reports success. This coordinator is neither
another transport nor durable authority.

Relevant views may observe shared state, but actionable device requests target one
eligible desktop controller. Passive observation or browser chat cannot steal
control. Pending requests retain their dispatched recipient. Direct provider-auth
interactions target their requesting connection. This is single-user multi-view
routing, not multiplayer authorization.

### Renderer

The sandboxed renderer has no Node integration or raw Electron IPC. It owns React
presentation, one window-local r-state-tree, and application/UI workflow state.
Renderer infrastructure owns the Effect runtime, generated `CakeIpcClient`, typed
Promise-based `Client`, and common Stream observation primitive.

Ordinary Stores and Models do not import Effect, RPC, Layers, Fibers, raw transport
contracts, synchronization infrastructure, Pi, or privileged implementations.
Browser and desktop surfaces share conversation behavior; their bootstraps attach
only the observations and persistence appropriate to their host.

## Renderer state ownership

Before adding state, identify its authority, cohesive owner, lifetime, persistence
boundary, and concurrency policy.

- **Models** are validated reactive projections, not durable authorities. The
  window-owned Model observer applies authoritative snapshots with `applySnapshot`
  and reduces ordered events transactionally with batched incremental mutations.
  It owns observation demand and cancellation; Models know nothing about transport.
- **Stores** are cohesive behavioral components for named product surfaces. They
  read Models and invoke semantic Promise operations on `Client`; workflow timers,
  cancellation, repeated-call policy, and UI persistence belong here. Main domain
  modules retain authoritative business rules.
- **RootStore** composes window dependencies; **NavigationStore** owns cross-Store
  navigation intents and coordinates focused workflow owners. Window lifetime does
  not make either the owner of every workflow. Parent Stores coordinate without
  copying child state or publishing one-for-one forwarding facades. Provider scopes
  are lookup scopes, not ownership scopes.
- **React** retains only tiny DOM, focus, hover, measurement, animation, or isolated
  input state. Dispose external resources with their actual owner.
- **Window persistence** is infrastructure outside the Store tree: load a versioned
  snapshot before mounting, then save mounted snapshots through `Client`. Never
  reapply storage into an already-mounted Store tree.
- **Every chat surface** renders the authoritative `Chat` with the shared
  `ChatStore`. Contextual framing may wrap it; no parallel transcript, message
  renderer, composer, input, or chat-specific control set is allowed.

Every Model and Store lives in its own file. Projection Models target
`src/renderer/models/` with PascalCase names not ending in `Model`; Stores live in
`src/renderer/stores/` with PascalCase names ending in `Store`. Main-owned storage
is ordinary Effect Schema data, not a renderer Model. Supporting utilities belong
outside Model/Store directories.

## Trust and extensibility

Model-presented content is data, never privileged application code.

- Artifacts and blocking requests cross bounded, validated protocols. Generated
  HTML/React executes in an opaque-origin sandbox with restrictive CSP and explicit,
  validated capabilities, not Node, Electron, credentials, or parent DOM access.
- Session Plugin state is main-owned; sandbox-local React state is mount-local.
  Hiding a plugin is a user preference, not deletion or permission to reopen it.
- Pi Extensions execute with main-process authority and are not sandboxed.
  Explicitly installed trusted React companions run in the renderer with a
  validated bridge and error boundary; they can inspect and interfere with its DOM.
  Never treat that trusted path as a sandbox for model-generated code.
- Utility work uses Pi's model runtime with bounded input/output, timeout,
  cancellation, and validation. Results are advisory until the owning feature
  commits them. Missing configuration skips optional utility work, never falls
  back to the conversation model.

## Development invariants

Prefer Pi's public APIs; keep the adapter narrow and renderer values Cake-owned.
Build vertical behavior through real boundaries. Validate boundary data, propagate
cancellation, release observations, and reject late results after replacement.
Keep Cake greenfield: remove replaced APIs and update callers, tests, and docs,
without compatibility shims unless explicitly requested. Add machinery only when
concrete behavior demonstrates a need. Preserve unrelated changes and verify
focused tests plus the relevant typecheck or build.

Feature changes should update their focused docs or tests, not grow this guide
with timings, pagination sizes, animation recipes, or operation inventories.

## Focused references

| When the task touches…                                                  | Read…                                                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Domain terminology                                                      | [Cake vocabulary](./cake-vocabulary.md)                                                                           |
| Services, runtime composition, RPC, Streams, storage, source boundaries | [Effect architecture](./effect-architecture.md)                                                                   |
| Persistent storage                                                      | [Cake storage](./cake-storage.md)                                                                                 |
| Pi adapter assumptions and extension compatibility                      | [Pi contract](./pi-1.0-contract.md), [Pi compatibility](./s3-pi-compatibility.md)                                 |
| Project lifecycle and Session Families                                  | [Session contract](./s1-session-contract.md), [family contract](./session-family-contract.md)                     |
| Feature behavior and its tests                                          | [Feature guide index](../features/README.md)                                                                      |
| Artifacts and widgets                                                   | [Artifact protocol](./s4-artifact-protocol.md)                                                                    |
| Interviews                                                              | [Interview ownership](./interviews.md)                                                                            |
| Standalone backend, sharing, browser/remote hosts                       | [Headless backend](../development/headless-backend.md)                                                            |
| Permanent Cake Chat and memory                                          | [Cake Chat memory](../development/cake-chat-memory.md), [durable runtime](../development/cake-chat-durable.md)    |
| Renderer workflow verification                                          | [Store testing](../development/renderer-store-testing.md), [Electron testing](../development/electron-testing.md) |
