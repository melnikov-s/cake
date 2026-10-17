# Cake architecture and product model

This document defines Cake's boundaries, ownership, and invariants. It is not a
feature catalog or roadmap. Read feature behavior only when the task touches it;
[focused references](#focused-references) route to those contracts and tests.
[The vocabulary](./cake-vocabulary.md) defines canonical terms;
[Effect architecture](./effect-architecture.md) defines runtime implementation
rules. This document is the single authority for renderer-state ownership,
Model/Store organization, and shared-chat contracts; `AGENTS.md` links here rather
than maintaining parallel rules. The [documentation map](./README.md) explains
maintained-guide and task-artifact responsibilities.

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

The conversation remains primary. Files, reviews, and artifacts
support the work rather than turning Cake into a general-purpose IDE. Embedded
VS Code owns source browsing, editing, Source Control, and native Git diffs.

## Pi backends

The two Pi backends are an intentional product distinction, not competing
transcript authorities:

| Conversation                                       | Engine and persistence                                         | Focused contract                                         |
| -------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Project Sessions and regular-Pi auxiliary sessions | Pi coding agent; Pi session files and `SessionManager`         | [Pi contract](./pi-1.0-contract.md)                      |
| Permanent Cake Chat coordinator                    | Pi Durable; SDK-owned SQLite originals, inbox, and checkpoints | [Durable storage](./cake-storage.md#permanent-cake-chat) |

Shared Conversation values and `Chat` presentation do not imply identical engine
APIs, queue durability, or restart behavior. Cake Chat's bounded summary memory
uses the same Durable SDK storage authority; regular Project Session execution
remains with the coding agent.

## Sources of truth

Every durable fact has exactly one authority. Identity, runtime lifetime, and
projection lifetime are distinct.

| Concern                                                                  | Authority                                   | Cake's boundary                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Regular-Pi conversation history, branches, compaction, session names     | Pi Session files and `SessionManager`       | Project validated Conversation values; never persist a second transcript          |
| Permanent Cake Chat history, inbox, execution checkpoints                | Pi Durable's SQLite adapter                 | Project original history and live state through shared Conversation contracts     |
| Models, providers, authentication, Pi settings and resources             | Pi                                          | Expose controls through the Pi adapter                                            |
| Model presets and utility/non-chat preferences                           | Cake application storage                    | Resolve explicit selections through Pi; never silently substitute a model         |
| Projects, workflow statuses, routing, Managed Worktree policy            | Cake                                        | Store metadata, not copies of Git or Pi state                                     |
| Checkouts, branches, working-tree changes                                | Git                                         | Coordinate lifecycle; VS Code presents live changes                               |
| Session Family membership, order, Working Directory bindings, resolution | Cake                                        | Members keep independent Pi transcripts; only the root owns family resolution     |
| Cross-session coordination                                               | Cake                                        | Own routing, correlation, and closure, not message text                           |
| Discussion/review scope and anchors                                      | Cake                                        | Replies remain in independent Pi sidecar sessions                                 |
| Pending scheduled delivery                                               | Cake                                        | Own cancellable intent until Pi accepts the ordinary message                      |
| Artifacts                                                                | Cake global lineage repository              | Immutable revisions with explicit session/family links; caches are disposable     |
| Session Plugins                                                          | Cake application metadata and JSON state    | Session-bound controls with user-owned visibility                                 |
| Window selection, layout, unsent composer input, workflow presentation   | Cake renderer/window storage                | Presentation state is separate from domain facts                                  |
| Interviews                                                               | Active Pi tool call and interview contracts | One validated response or cancellation; session-owned form state, not an artifact |

Explicitly saved Draft records are shared backend data, distinct from client-owned
[unsent composer input](./README.md#saved-drafts-and-unsent-input).

Do not mutate Pi JSONL with ad hoc file operations, reconstruct Pi state into a
competing domain model, or make a Project Session-shaped shadow payload. Main
keeps related facts in focused authorities. The renderer joins only the
projections needed by a surface. References do not transfer ownership.

### Conversation invariants

- Every materialized Cake Session has exactly one Conversation backed by exactly
  one Pi Session. Releasing a runtime or observation does not delete it.
- Regular-Pi display history is the complete active branch from
  `SessionManager.getBranch()`, not compacted model input from
  `buildContextEntries()`. Permanent Cake Chat presents original-history pages
  and a live projection, not its derived summary nodes or context resets.
- Never silently hide current model-facing system reminders or custom messages,
  including Cake/extension messages, regardless of Pi's `display` flag. Disclose them as
  inspectable context pills; group consecutive pills horizontally with wrapping,
  not separate rows. Expose
  the live runtime's instructions in five source groups: **System** (Pi, Cake,
  session guidance, working directory, and other additions), **Tools** (usage
  descriptions and complete declarations), **Skills**, **Worktree** only when
  applicable, and **AGENTS.md** (all loaded instruction files, retaining their
  paths and contents). Forks display inherited instruction history in place, not a
  synthetic fresh runtime baseline. Checkout relocation preserves equivalent
  instruction-file and skill sections; a small path mapping and replacement
  worktree guidance carry the move instead of redeclaring unchanged sources.
  Genuine instruction/tool changes remain inspectable in the timeline.
  Presentation does not create another transcript authority.
- Project Session Tool Compact replays only user-authored input and assistant text as dialogue.
  Preserve Pi's canonical system prompt/tool baseline as a folded checkpoint, not
  a new instruction injection. Strip injected reminders (including embedded ones),
  reasoning, tools, custom messages, and cross-session coordination. Keep
  orientation/provenance in non-context Pi metadata and the original transcript
  tree inspectable. Do not show Tool Compact notices or removed historical context
  pills in the continuation; preserve literal user-authored reminder tags as user
  content. The checkpoint does not add a new context pill; genuine later
  instruction changes do.
- Waiting user and cross-session inputs use the owning Pi backend's admission
  and queue mechanism. Regular-Pi queue metadata is transient; permanent Cake
  Chat's inbox is Pi Durable-owned. Cake does not persist a competing runtime
  queue. Scheduled delivery and report outboxes retain only their separately
  defined Cake-owned intents until handoff.
- Sidecar discussions and private subagents have independent Pi transcripts.
  Parent anchors, handles, and projections do not merge transcript ownership.
  Cake Chat investigators use Pi's in-memory SessionManager: their
  detailed history is process-local, while only compact reports and provenance
  remain in the parent Conversation.

### Lifecycle invariants

- Session identity is independent of its Working Directory and renderer selection.
  Git checkout existence is not Session identity or resolution state.
- Resolution is Cake metadata, not transcript relocation. Family children inherit
  their root's resolution; they have no independent resolution authority.
- A Project Session cannot be archived while its Pi turn is active. A standalone
  agent's own resolution request is deferred until the settled-turn boundary,
  after the final transcript snapshot. Family lifecycle requests require every
  member to be inactive and are never deferred. A deferred standalone request
  cannot gain family-wide authority if the session becomes a family root before
  settlement.
- Git landing and Session resolution are separate actions. Sessions sharing a
  Working Directory share its lifecycle controls and terminals; resolving one
  must not retire a checkout still used by another active Session.
- Private Subagent Sessions are not selectable Project Sessions or Session Family
  children. Project agents use private delegation only on explicit user request.
  Cake Chat has direct read, bash and mcp tools (no edit/write) for quick checks,
  bounded by a scratch working directory, a short bash timeout and capped output;
  its prompt policy keeps project changes in Project Sessions and never mutates a
  project root checkout. It delegates deeper project-dependent investigations to
  an explicitly selected registered, trusted project root. These workers retain normal project
  instructions, skills, extensions and MCP, excluding edit/write tools and adding
  an investigation-only system policy. `allowMutations: true` on a worker's start
  replaces that policy with scoped mutation mode for bounded operational work
  (scripts, process cleanup, installs): stay in assignment scope, report every
  change, and avoid shared-branch Git mutations unless instructed. Both policies
  are prompt policy, not an enforced sandbox. General research omits projectPath and uses
  isolated instructions and read/bash/message_parent, without repository
  resources or guaranteed web/search access. Explicitly forwarded attachment/message
  references additionally grant a scoped Cake read gateway, never broad application control. Cake Chat handles support follow-ups
  until closed, backend shutdown, or the first idle moment 30 minutes after
  creation; turns have no time limit and an active turn is never expired. They are not
  restored after restart. Completion status is distinct from resource disposal.
  Reports retain Cake-authored structured provenance for Markdown response
  presentation, without changing model-facing input roles.
- Passive worker/result message-reference notifications never start or queue a parent turn.
  Cake retains their exact links as pending delivery intents and attaches them, without reading
  the referenced bodies, to the parent's next accepted conversational user input. This applies
  to Project Sessions, global Cake Chat, and Project Chat. Explicit substantive messages,
  questions/blockers, `message_parent`, deliberate steering, and requested `interrupt` reports
  retain their immediate-delivery semantics. Commands and shell escapes do not drain references.
- Automatic Project Session result handoff belongs to actual family parent-child assignments
  and independent sessions spawned by permanent Cake Chat, not arbitrary independent creators.
  Without an explicit report, a run's final answer becomes the result only when it answers the
  requester: Pi can consume later local-user or third-party input into the same run, and an answer
  to that input yields a factual stop notice instead of forwarding its text. Requester provenance and the pending delivery journal are Cake metadata; Pi remains transcript
  and run authority.

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
disconnection. This does not give every operation process-restart durability;
that guarantee belongs to its engine or focused workflow contract.

`src/services/pi` is the regular-Pi integration boundary. `CakeSessionRuntimes`,
`PiModels`, and `PiAgentResources` expose focused Cake capabilities. Permanent Cake
Chat's Durable SDK adapter lives in `src/services/pi-durable`, with runtime leases
still owned by `CakeSessionRuntimes`. Each Cake Session Runtime wraps one Pi-owned
runtime and returns a scoped Handle. Raw SDK objects and events stop at their
adapter boundary.

### Preload and transport

Preload exposes only the frozen, validated Effect RPC transport. It exposes no raw
`ipcRenderer`, Node, general Electron capabilities, or Cake business logic.

Cross-process requests, successes, typed failures, and Stream elements are untrusted
until parsed by shared runtime Schemas at the receiving boundary. Services, Layers,
Scopes, Fibers, Stores, and Models never cross that boundary. RPC handlers adapt to
domain operations; they do not own business policy.

Agent-invoked backend settings, Project settings, labels, session inspection, and
non-family message/thread coordination execute through domain handlers without a
renderer binding. Project Session, permanent Cake Chat, and session-assistant
gateways retain their distinct sender and task-input policies before dispatch;
family messaging and backend-direct creation/fork/worktree routes stay separate.
Thread bindings are transient backend metadata, not another transcript or a
restart-durable queue. Inspection reports backend facts; window selection remains
in `app.state`. Accepted mutations never wait for presentation: attributed action
notices are best-effort events to the caller's bound window, and shared Pi settings
changes refresh observing windows. Device/window actions still use reverse requests.

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
boundary, and concurrency policy. Stores compose as stateful behavioral components,
just as views compose presentation components. A complex application can require
many Stores; count and tree depth are not quality metrics. Judge encapsulation,
cohesive responsibility, and ownership rather than seeking fewer Stores. If an
owner can only be described as "everything in this window" or a list of unrelated
surfaces, use a focused Store instead. Existing concentration of unrelated state
is a refactoring signal, not precedent.

- **Models** are validated reactive projections, not durable authorities. The
  window-owned Model observer applies authoritative snapshots with `applySnapshot`
  and reduces ordered events transactionally with batched incremental mutations.
  It owns observation demand and cancellation; Models know nothing about transport.
- **Stores** are cohesive behavioral components for named product surfaces. They
  read Models and invoke semantic Promise operations on `Client`; workflow timers,
  cancellation, repeated-call policy, and UI persistence belong here. Give named
  surfaces named Stores, such as navigation/sidebar, project selection, active
  session/chat, changes, reviews, browse, and settings. Compose by ownership and
  lifetime: put shared Stores near the root; nest them only when one parent surface
  truly owns their lifetime and behavior. Main domain modules retain authoritative
  business rules.
- **RootStore** composes window dependencies; **NavigationStore** owns cross-Store
  navigation intents and coordinates focused workflow owners. Window lifetime does
  not make either the owner of every workflow. Parent Stores coordinate without
  copying child state or publishing one-for-one forwarding facades. Provider scopes
  are lookup scopes, not ownership scopes. Renderer bootstrap attaches focused
  event-routing observers, synchronization, and persistence infrastructure to the
  mounted Root Store; observers use the common Stream observation primitive and
  own their cancellation handles. **SessionCatalogStore** owns the single derived
  Project Session index joining authoritative and renderer-pending summaries, with
  authority winning by session ID. Lookup, global ordering, and Project groups
  consume that index; surface-specific ordering remains with its surface Store.
  Shared Project Session management and creation workflows are window-owned Root
  children, not workbench subsystems. Provide narrowly named Store contexts at the
  common owner and consume them at the feature that needs the capability, without
  forwarding them through the registry or exposing another owner's child layout.
  Project Session Stores bind session-specific policy into reusable conversation
  primitives; shared chat primitives do not consume Project-only contexts.
  **ScreenCaptureAttachmentStore** owns capture destination presentation and routing,
  including unsent pane identities that intentionally remain outside sidebar lists.
- **Agent session navigation** uses `sessions.open` through the invoking renderer’s
  existing application-control gateway and `NavigationStore`. Project Session targets
  are validated against the catalog; ordinary focused-pane/history policy applies,
  including focusing an already-open target. `SettingsStore.agentNavigation` owns the
  user-only permission: enabled by default, window-local, persisted in the existing
  window snapshot. It is not writable through agent Settings operations. Disabling it
  blocks agent navigation, not manual sidebar, history, or session-link navigation.
- **React** retains only tiny DOM, focus, hover, measurement, animation, or isolated
  input state. Dispose external resources with their actual owner.
- **Window persistence** is infrastructure outside the Store tree: load a versioned
  snapshot before mounting, then save mounted snapshots through `Client`. Never
  reapply storage into an already-mounted Store tree. One-way window snapshot
  transport is renderer infrastructure outside that tree.
- **Every chat surface**—project-session, Cake Chat, pop-up, selection, comment,
  review, inline, modal, secondary, and future surfaces—renders the authoritative
  `Chat` from `src/renderer/components/chat.tsx` with an instance of the shared
  `ChatStore` from `src/renderer/stores/ChatStore.ts`. Extend these abstractions
  when new behavior is needed. Contextual framing may wrap them, but must not
  replace conversation behavior or controls. No parallel chat component,
  transcript, message renderer, composer, input, Store contract, or chat-specific
  control set is allowed.

Every r-state-tree Model and Store lives in its own file; never colocate multiple
Models or Stores or mix them with utilities or unrelated code. Projection Models
live in `src/renderer/models/`, which contains only Model files, with PascalCase
names and filenames not ending in `Model`. Stores live in `src/renderer/stores/`,
which contains only Store files, with PascalCase names and filenames ending in
`Store`. Main-owned application/storage data is ordinary Effect Schema data, not a
renderer Model. Supporting utilities belong in `src/utils/` or the appropriate
service/domain directory, never in Model/Store directories.

## Trust and extensibility

Model-presented content is data, never privileged application code.

Remote access currently assumes one trusted user with multiple views. Its access
controls are incomplete; accepted clients have full backend authority. Host/Origin
validation is not authentication. Further restrictions are future work, not
existing guarantees; see [the host guide](../development/headless-backend.md#scope-and-security-status).

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
| Feature behavior and its tests                                          | [Source](../../src/), [workflow tests](../../tests/app/)                                                          |
| Artifacts and widgets                                                   | [Artifact protocol](./s4-artifact-protocol.md)                                                                    |
| Interviews                                                              | [Interview ownership](./interviews.md)                                                                            |
| Standalone backend, sharing, browser/remote hosts                       | [Headless backend](../development/headless-backend.md)                                                            |
| Permanent Cake Chat and memory                                          | [Durable runtime](../../src/services/pi-durable/), [tests](../../tests/app/services/pi-durable/)                  |
| Renderer workflow verification                                          | [Store testing](../development/renderer-store-testing.md), [Electron testing](../development/electron-testing.md) |
