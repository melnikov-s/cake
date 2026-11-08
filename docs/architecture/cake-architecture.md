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

| Concern                                                                  | Authority                                   | Cake's boundary                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Regular-Pi conversation history, branches, compaction, session names     | Pi Session files and `SessionManager`       | Project validated Conversation values; never persist a second transcript             |
| Permanent Cake Chat history, inbox, execution checkpoints                | Pi Durable's SQLite adapter                 | Project original history and live state through shared Conversation contracts        |
| Models, providers, authentication, Pi settings and resources             | Pi                                          | Expose controls through the Pi adapter                                               |
| Model presets and utility/non-chat preferences                           | Cake application storage                    | Resolve explicit selections through Pi; never silently substitute a model            |
| Projects, workflow statuses, routing, Managed Worktree policy            | Cake                                        | Store metadata, not copies of Git or Pi state                                        |
| Checkouts, branches, working-tree changes                                | Git                                         | Coordinate lifecycle; VS Code presents live changes                                  |
| Session Family membership, order, Working Directory bindings, resolution | Cake                                        | Members keep independent Pi transcripts; only the root owns family resolution        |
| Cross-session coordination                                               | Cake                                        | Own routing, correlation, and closure, not message text                              |
| Discussion/review scope and anchors                                      | Cake                                        | Replies remain in independent Pi sidecar sessions                                    |
| Pending scheduled delivery                                               | Cake                                        | Own cancellable intent until Pi accepts the ordinary message                         |
| Artifacts                                                                | Cake global lineage repository              | Immutable revisions, session/family links and global retention; views are disposable |
| Session Plugins                                                          | Cake application metadata and JSON state    | Session-bound controls with user-owned visibility                                    |
| Window selection, layout, unsent composer input, workflow presentation   | Cake renderer/window storage                | Presentation state is separate from domain facts                                     |
| Interviews                                                               | Active Pi tool call and interview contracts | One validated response or cancellation; session-owned form state, not an artifact    |

Explicitly saved Draft records are shared backend data, distinct from client-owned
[unsent composer input](./README.md#saved-drafts-and-unsent-input).

Do not mutate Pi JSONL with ad hoc file operations, reconstruct Pi state into a
competing domain model, or make a Project Session-shaped shadow payload. Main
keeps related facts in focused authorities. The renderer joins only the
projections needed by a surface. References do not transfer ownership.

### Conversation invariants

- Every materialized Cake Session has exactly one Conversation backed by exactly
  one Pi Session. Releasing a runtime or observation does not delete it.
- Transcript scroll ownership belongs to the reader. One owner,
  `src/renderer/lib/transcript-scroll-owner.ts`, is the only writer of a shared
  `ChatTranscript`'s scroll position. It follows new content only while the
  reader is at the bottom; anywhere else it never scrolls for the reader and
  compensates every layout change (streaming, arriving messages, tools, cards,
  virtual measurement, resizes) so the visible reading content stays still,
  including image growth or table rewrapping inside a tall message. The owner
  records visible prose in the reading row and holds the first displaced block;
  unchanged prose before growing media must not hide movement below it. A block
  crossing the viewport top uses a visible text character before later blocks;
  a clipped table cell yields to fully visible prose below the table. Deliberate message reveals
  and disclosure keep their row/heading anchor. Anchors are stored in content
  coordinates, so compensation cannot undo
  a native scroll whose event is still queued. Following stops as soon as the
  reader moves up (wheel, touch, keys, scrollbar, or any other upward movement)
  and resumes only when the reader returns to the bottom. Any upward movement
  of a pixel or more away from the end is the reader's, even without input the
  transcript saw (a gesture over an iframe, a scrollbar drag, find-in-page) and
  even when a commit or resize lands before its scroll event; only a browser
  clamp moves up and still lands at the end. Anchors use layout positions, so
  a live arrival's entrance transform is never compensated. Sending a message is
  the single programmatic scroll to the bottom: typed and voice-mode sends
  both go through `ChatStore.submit`, which bumps
  `TranscriptInteractionStore.sentMessageRevision`, and the transcript reacts to
  that. No other action (worktree commands, leaving keyboard selection,
  arriving content) may jump there.
  Keyboard or linked message selection reveals its message once by stable item
  key, pauses following, and is otherwise ordinary reading. The
  pinned Virtuoso patch keeps upward size compensation disabled
  (`skipUpwardScrollCompensation`) and exposes `cancelScrollToIndex` so reader
  input or a completed reveal stops index-navigation retries. Initial probes
  measure the requested item's data, not the first item, so restoring an offset
  inside a tall message uses that message's real height. Do not add
  another scroll writer; route new layout triggers through the owner's
  `reconcile()`.
- Regular-Pi display history is the complete active branch from
  `SessionManager.getBranch()`, not compacted model input from
  `buildContextEntries()`. Permanent Cake Chat presents original-history pages
  and a live projection, not its derived summary nodes or context resets.
- Never silently hide current model-facing system reminders or custom messages,
  including Cake/extension messages, regardless of Pi's `display` flag, except the
  hidden `cake.restart-recovery` execution trigger and typed `UpdateBatch`,
  `AgentUpdate` and user-carried report routing/reminder instructions. Keep these in Pi and Browse context, not ordinary
  conversation. Project sender-authored passive notices as individual Markdown messages
  with their structured cross-session provenance and stable notice identity, never as
  generic context pills or user-authored words. Worker progress and deferred reports
  retain source identity and public original links in typed input presentation metadata;
  the human input is recorded separately from injected reminders. Report obligations
  may be reminded repeatedly in model context, but their sender-authored presentation
  is admitted once, using the stable report identity. User-carried and timer-carried notices
  use the same projection across queues, live consumption and persisted replay. Suppress repeated system sections and resets
  differing only by Cake's terminal-documentation adaptation; retain genuine
  instruction/tool changes. Disclose context as
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
  Application-generated Workboard wake inputs carry typed admission provenance,
  persisted in regular Pi metadata or the Durable input envelope and retained by
  recovery. Project and Session Chat present these as Workboard summary context
  pills, not user-authored bubbles or raw transport markup/storage identities.
  The exact model payload remains in Pi and Browse context. Never infer internal
  provenance from `<system-reminder>` text: genuine user quotations remain dialogue.
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
  and queue mechanism. Worker reports, batched updates and Workboard deliveries are
  typed internal inputs in that same queue: visible queue rows that can be steered,
  sent now, reordered or removed like a user message, and that survive edits to other
  rows. Empty-composer Enter escalates only the user's own latest message (queue,
  then steer, then send now), never another sender's row. Primary-session admission retains a durable recovery intent
  until settlement; it is not transcript history or a second execution queue.
  Regular Pi records input-consumption identities in its own transcript metadata,
  allowing restart to reconstruct unconsumed inputs without replaying consumed
  messages. Permanent Cake Chat's inbox and task checkpoints remain Pi Durable-owned.
  Scheduled delivery and report outboxes retain their separately defined intents.
- Sidecar discussions and private subagents have independent Pi transcripts.
  Parent anchors, handles, and projections do not merge transcript ownership.
  Permanent-chat implementation/code changes default to `sessions.create`: fresh
  independent Project Sessions with scoped tasks, meaningful context and managed
  worktrees, never family children. Useful-context investigation with implementation
  not yet clear uses `sessions.fork`: agent-owned read-only context-forked subagents,
  never human Side Chats. Fork describes context inheritance, not role or ownership.
  Needed code changes require findings handed off to a fresh Project Session.
  Fresh-context subagents require an explicit request; context forks are allowed subagents.
  Requested different models use fresh-context investigators directly.
  The shared backend captures Pi Durable's settled model context at a completed reply
  and seeds a private Pi-owned subagent transcript. Historical system context carries
  no live coordinator authority or tool grants; the worker gets current investigation-only
  project resources in its managed worktree. The unfinished exchange must be supplied
  in initialPrompt. No Discussion record, message anchor, pane, tab or merge-history
  affordance is created. Public handles, recovery, exact result links, notification/reply
  delivery and idle cleanup use the existing subagent lifecycle. Unsupported hosts fail
  visibly, never fall back to a Side Chat. Notification is the default; reply is for
  owed answers/dependencies.
  Existing wrongly-created task Side Chats are preserved, not migrated or interrupted.
  Native Side Chat IDs resolve through their saved Discussion
  owner, not the Project Session catalog: exact messages, stop, metadata and navigation
  use the Discussion profile, including cold acquisition after restart. Session-linked
  to-dos follow Discussion resolution. Legacy task forks retain their managed-worktree
  ownership for landing committed work; read-only forks cannot be prompted to commit
  or resolve conflicts, so those repairs require recovery into a Project Session.
  User-created side chats inherit the originating conversation's applicable tools,
  permissions and explicit user restrictions. They are not read-only
  or to-do-only workers. Parent-scoped Cake controls retain originating authority;
  cross-conversation messages carry the side chat's own sender identity and can use
  the explicit `parent` target. Receipts alone do not prove delivery visibility or execution.
  User-created Project Chat and Cake Chat side chats can explicitly import their new
  dialogue into the parent's Pi-owned history. Imports are attributed historical
  groups at the merge point, not replayed requests; they start no turn, execute no
  tools, and do not close the source or merge code. Both conversations must be idle.
  Import identities persist in Pi so subsequent merges add only new dialogue.
  Inherited branch context and injected control inputs are not imported. Imported
  originals participate in parent memory and remain available for exact recall.
  Private workers, including Cake Chat investigators, retain their detailed history in
  Pi-owned session files. Cake checkpoints handle identities, exact capability grants,
  unfinished admissions and completion receipts, not a copy of that history. Only
  compact reports and provenance cross into the parent Conversation.
- Private subagents always keep Pi auto-compaction on, whatever the
  user's Project Session auto-compact setting: nobody can compact them by hand mid-run. For every regular-Pi
  runtime, a run whose final response errored or stopped at a token limit settles as
  failed with that reason (`CakeSessionRuntimes`), never complete, so no truncated or
  mid-task text becomes a worker's or spawned session's result.
- Cake-owned prompt kernels are role-specific: Cake Chat and Project Sessions
  share only role-neutral authority, trust and presentation rules. Project
  investigators retain project resources plus their scoped worker/mutation policy,
  not ordinary Project Session application/family authority. Family overlays supply
  identity and root lifecycle, without repeating the main recursive Workboard policy.
  Detailed operational and exact-revision visual handoff rules live in bundled,
  content-addressed readable guides, with explicit pre-action reading gates in each
  applicable kernel. Cake Chat deploys the same guides as Project Sessions; its
  user-authored dedicated instructions are appended verbatim. The little-guy companion is
  one projectless permanent Cake Chat identity with its own Pi Durable database and OptMem
  history, never a per-task sidecar or imported parent transcript. It follows the utility
  model and has independent instructions, a 10/5 KB default memory view and 32k active
  context limit, customizable through Settings and companion.* setting keys. Window-owned
  presentation reuses the existing quick-click and right-click chats in Project Sessions,
  Project Chat and global Cake Chat. Real context entries/exits are passive Durable originals
  using Cake's system-reminder format (invoking session ID/title/type/mode, Project name/path,
  Working Directory and Managed Worktree checkout/branch when present), including disconnect
  cleanup. These location values are data, not instructions or the companion's own working
  directory. Title and location changes refresh orientation; projectless chats and context
  exits clear prior scope. Ordinary messages add no reminder and transitions never wake or
  interrupt an agent. Deeper session context and
  navigation use existing validated Cake tools, with unchanged trust and action safeguards.
  Explicit session target `parent` resolves at admission: companion → current invoking
  context, child → actual family parent, top-level Project Session → owning Project
  Chat, Project Chat → Cake Chat, Cake Chat → itself. Creator/source links are not
  ancestry; absent companion context fails rather than guessing. Schedules persist
  the concrete destination, and omitted scheduling targets always mean caller/self.
- Agent discovery follows list → inspect → bounded read. Lists return exact routing
  identities, short labels and selection-relevant metadata, not content, transcripts,
  full settings, file manifests or reports. Apply domain filters and deterministic
  ordering before pagination. New in-memory catalogs share `AgentListInput` (20 items
  by default, maximum 50) and `agentListPage`; `nextOffset: null` marks completion.
  Existing cursor-based, metadata-only discovery keeps its bounded protocol. Exact
  inspection returns full metadata; content reads are explicit and independently
  bounded. Pending and scheduled inputs expose short labels; `pending-info` and
  `scheduled-info` read one exact input in text slices. Queue mutations return counts,
  not message bodies; edit user text in place via read plus update-queued, preserving
  identity, attachments and delivery lane without sending or bulk dequeue.
  `app.state` reports window orientation/counts, not duplicate rosters.
  Model-facing text for project, family, report, model, attachment and message catalogs
  uses compact tab-separated rows, formatted only after authorization/redaction and
  identity projection. Exact routing cells are losslessly escaped. Opaque message and
  attachment links remain intact. This is a disposable text view: underlying domain
  results, tool details and declared typed output contracts do not become tables.
  Details, body reads, errors and other operations keep their existing presentation.
  Text uses `next=N`/`after=ID` only when more results exist; metadata retains its
  existing pagination protocol. Oversized catalog pages retain the valid JSON
  truncation envelope rather than cutting a routing cell into a partial row.
  Gateway topics list enabled operation summaries, `<operation>.help` supplies the
  selected input/behavior contract, and `<operation>.output-schema` opts into the
  complete result schema. Runtime validation remains authoritative at every layer.
  Oversized JSON text uses a valid truncation envelope, never clipped JSON; canonical
  structured results retain their separately validated size limit. Character-budget
  tests guard Cake-owned kernels/catalogs without charging arbitrary user resources.

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
  an explicitly selected registered project root. These workers retain normal project
  instructions, skills, extensions and MCP, excluding edit/write tools and adding
  an investigation-only system policy. `allowMutations: true` on a worker's start
  replaces that policy with scoped mutation mode for bounded non-code operational work
  (scripts, process cleanup, installs): stay in assignment scope, report every
  change, and avoid shared-branch Git mutations unless instructed. Both policies
  are prompt policy, not an enforced sandbox. General research omits projectPath and uses
  isolated instructions and read/bash/message_parent, without repository
  resources or guaranteed web/search access. Explicitly forwarded attachment/message
  references additionally grant a scoped Cake read gateway, never broad application control. Cake Chat handles support follow-ups
  until closed or expired while idle; turns have no time limit and an active turn
  is never expired. Backend shutdown releases resources without closing handles or
  reporting cancellation. Startup restores worker identities and exact grants before
  parent continuations, then resumes safe work using Pi's saved branch. Unfinished
  tools require review rather than replay. Completion receipts suppress duplicate
  parent reports. Completion status is distinct from resource disposal.
  Closing/expiring a worker commits minimal durable handle → private Pi Session →
  parent ownership separately from recovery intents and capability grants. Released
  history is projected read-only from Pi's complete persisted branch without acquiring
  a runtime. Parent resolution preserves these identities and links; explicit parent
  or Project Session deletion removes owned transcripts and metadata recursively,
  never workers belonging to another parent. Missing originals or erased historical
  mappings are explicit failures, not empty chats or reconstructed parent reports.
  Identity repair requires retained exact routing evidence (recovery metadata/backups,
  or a pending completion notice's handle/private-session/recipient tuple plus a verified
  transcript location); task text, model, timestamps and final reports are not identity.
  Reports retain Cake-authored structured provenance for Markdown response
  presentation, without changing model-facing input roles.
- Session launch/send uses one canonical `resultDelivery: "reply" | "notification" | "ignore"`.
  Reply transports the correlated application-confirmed result and starts/queues a normal
  parent turn; notification retains a compact exact result-message link in the parent's pending
  batch (next real user input, or one batched turn within 5 minutes/before cache expiry) without a
  per-result turn; ignore creates neither obligation nor notification.
  The application owns correlation, settlement, entry links and retry/deduplication; no worker
  manual completion call is required. Artifact/link-only presentation cannot suppress a reply
  wakeup. Durable transport is not a guarantee of exactly-once LLM prose. Direct questions
  are immediate; explicit blockers escalate after worker settlement. Private subagents retain
  their separate continuation:none/resume contract. Family children use the same dependent-result choice:
  reply when the parent needs the result next or owes the user an answer, notification
  for background review. Choosing reply for already-authorized work needs no new authorization
  and does not block. Workboard posts and correlated completion obligations remain distinct;
  no duplicate private wake-up or report is needed. See `docs/agent/communication.md`.
- Automatic Project Session result handoff belongs to correlated result-requesting messages and permanent-chat launches,
  not arbitrary session relationships or later unrelated local user turns.
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
renderer binding. Project Session and permanent Cake Chat gateways (including the
companion) retain their sender and task-input policies before dispatch;
family messaging and backend-direct creation/fork/worktree routes stay separate.
Thread bindings, closed state, message identities and settled outcomes are durable
Cake coordination metadata, never another transcript or execution queue. Inspection reports backend facts; window selection remains
in `app.state`. Accepted mutations never wait for presentation: attributed action
notices are best-effort events to the caller's bound window, and shared Pi settings
changes refresh observing windows. Device/window actions still use reverse requests.

#### UI and Cake tool parity

Every user-facing setting must have discoverable Cake tool read/write parity,
through the same validation, authority, persistence and live-update path as its UI.
Add or update the tool contract and workflow coverage with the UI setting, not as
follow-up work. A concrete exception must name its boundary and supported user path:
credentials remain masked/interactive, agent-navigation authorization remains
user-owned, and OS-only actions may require native interaction. A missing tool is
a product gap, not a permission restriction. Likewise, meaningful mouse/keyboard
capabilities should have semantic tool equivalents where sensible; avoid arbitrary
DOM selectors, simulated clicks and permission bypasses. Settings navigation uses
`settings.open` with stable page/setting identities and the existing user-owned
agent-navigation permission. Its result acknowledges navigation intent, not pixels
painted or a setting changed.

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
  **ScreenCaptureAttachmentStore** owns native capture preferences and attachment routing.
  Destination selection lives on the first native capture screen, using shared sidebar
  row primitives and a capture-lifetime `CaptureDestinationPickerStore`. Only frozen
  destination presentation facts cross into the native renderer; no application Store,
  sidebar disclosure state, or duplicate catalog subscriptions are created there.
  Completion revalidates the destination, including unsent pane identities. The default
  follows `AppShellStore.lastInteractedConversation`, recorded at explicit sidebar and
  conversation-pane pointer/keyboard boundaries, not programmatic navigation or focus.
  Capture choices and completion navigation never update that interaction record.
- **Project Chat to-dos** are Project-owned ApplicationStorage data, projected through
  the existing Project catalog into `Project.todos`; `ProjectTodosStore` owns only
  local edits, disclosure and focus/context interaction. `WorkspaceNavigatorStore`
  owns the right-hand accessory's visibility, width and exclusive To-dos/Sessions
  mode. In Browser and VS Code modes, that content shares the existing companion
  pane with Chat through Chat/Todos/Sessions tabs instead of a second accessory.
  Companion selection is window-local; switching tabs does not replace the tool
  workspace. Existing Workspace operations select Todos/Sessions there, and closing
  that content returns to Chat. Each owning
  Project's permanent `ProjectTodosStore` remains stable while workers or secondary
  conversations are focused. Explicit reply context attaches to the actually focused
  ChatStore through its existing composer; view focus never attaches context. Actual new Project Sessions get one linked item at
  start/child/fork boundaries, idempotent by canonical session identity. Agent guidance
  requires an item for building work, multi-step investigations or research, brainstorms the
  user wants to revisit and pending user decisions, but not for one-shot lookups or quick
  operations, even when delegated; research stays open after its report until the user has
  reviewed it. Items have a title, short latest-update description and freeform agent
  status metadata; the pane displays the description. Optional titled session, message, artifact, web and workspace associations use
  shared conversation navigation. Backend lifecycle authority completes linked open items
  once all actual session associations are resolved (UI and tools alike). Metadata-only,
  idempotent reconciliation handles late associations and legacy open items at startup;
  source/report links are context, not required work. First-class subagent associations use the public
  handle plus canonical parent identity, never a private Pi session ID. They open the parent’s
  existing worker chat/report and use a distinct type icon. Subagents have no resolve lifecycle:
  reports, execution completion, abort and resource release do not close a subagent-only item;
  explicitly mark it done after review. Mixed items retain the all-Project-Sessions-resolved rule.
  Session restore never reopens items. Human Mark done, from lists or linked chat controls,
  resolves all required session associations through the backend lifecycle before committing Done.
  Children use their family root once, preserving whole-family safety checks; already-resolved
  links are skipped. Unknown links, active turns/workers, pending input and other lifecycle blockers
  surface errors without falsely completing the item. Partial resolution is retained for retry.
  This path does not merge, delete, retire checkouts or abort turns. Agent to-do edits and
  attention dismissal, hiding, snoozing or pill deletion never resolve sessions. Each open item may
  persist one explicit UTC `snoozedUntil` deadline, a `needsAttention` flag and a separate
  bounded, nonempty `attentionReason`. Older saved items may omit attention fields (off);
  no reason is invented. Four exclusive sections, in order: Needs attention (open, unsnoozed,
  flagged), Active (open, unsnoozed, unflagged), Snoozed (open with a deadline), Done.
  Needs attention shows expanded only when its filtered list is nonempty; when empty, its
  heading, count and section spacing/divider are omitted. The other sections collapse independently. It presents the human action first, with quieter task identity and clickable
  work/source links, no attention bell. Row selection focuses the transcript view, never outgoing context.
  Explicit to-do mutations own human-request attention; background description refresh stays description-only.
  Notification-mode completion reports linked to an open to-do in the recipient durable chat's own
  list are held in the existing report inbox and flag that item. Composer pills sit beneath Activity,
  above the input, independent of Workspace search or transcript focus. Opening a pill admits its held
  originals through the normal chat runtime, then clears only attention. Its X only clears the flag;
  held reports never ride on unrelated input or timed batches. Explicit reply delivery remains immediate.
  No click completes the item, merges work, resolves sessions, or approves those actions.
  One-step Dismiss clears only the flag, retaining the hidden reason, selection and work state.
  An agent cannot reactivate an identical retained dismissed reason; genuinely new requests use
  changed reasons. Explicit user Restore bypasses suppression. Native context menus provide
  Restore, Mark with a manual reason input, or Edit; no utility-model inference. User attention
  edits enter the existing durable user-change reminder. Completion clears the flag but retains
  the reason; reopening starts Active. Snoozing retains attention and takes visibility precedence;
  attention edits never unsnooze. A single
  backend-scoped worker repairs overdue deadlines at startup and checks wall time every second,
  without requiring a renderer, open pane or chat runtime; idle passes do not write. Expiry
  clears only the deadline through the serialized ApplicationState transaction and publishes
  visibility (Needs attention if still flagged, otherwise Active), never a reminder, input, session wake, execution pause or model schedule.
  Transactions recheck deadlines so extension, manual unsnooze and completion cannot be
  overwritten by an old expiry snapshot. Any completion clears the deadline; reopening starts
  Active. The worker reconciles affected lists after expiry so a racing resolution join cannot
  lose completion to the expiry revision. UI custom times are local, tools take validated future
  UTC timestamps, and snooze/unsnooze mutations preserve revision checks and chat scope grants.
  ApplicationStorage publication drives the pane and toolbar's total unsnoozed-open count without loading/waking Project Chat.
  Existing passive notifications, explicit result reports, final Project Session turns and worker completion
  enqueue best-effort description refreshes before normal notification delivery.
  A scoped backend consumer uses the configured utility model with only the task title,
  current description and bounded new report text; no transcript, tools or chat wake.
  Unchanged/invalid output or provider failure keeps the current description; revision
  checks discard results made obsolete by another edit. Reports do not close items or
  acknowledge delivery. This queue is ephemeral; pending refreshes are not replayed after
  restart. Normal durable reporting remains unchanged.
  Summary calls have a ten-second deadline, without retries or foreground-model
  fallback. To-do ordering never calls a model and has no user sort controls.
  Each section shows newest-created items first by immutable `createdAt`, with
  ascending item ID breaking equal timestamp ties. Older saved items without creation
  timestamps follow timestamped items in reverse append-only storage order.
  Description/status edits and linked-session activity never promote older items.
  Search preserves this order. ApplicationStorage records creation time only for new
  items and continues recording `modifiedAt` for content/lifecycle changes; selection
  and read acknowledgement change neither timestamp.
  One metadata-index snapshot and family snapshot join a bounded page, with filename-only
  identity enumeration per directory, never per item.
  Tools default to title/id/state/revision rows, attention flag and retained reason (plus snoozedUntil when set) and compact mutation receipts with canonical attention outcomes; content is
  disclosed by exact detail or opt-in detail only. Each item records its latest completion
  (revision and user/agent/sessions source). Requesting `done` on a done item is a no-op
  for state; a stale `done` edit whose only intervening change was that completion
  still applies its other fields, while any other intervening edit stays a revision
  conflict. Transcript view focus is window-local and survives closing the To-do panel;
  explicit unfocus/clear or removal of the item ends it. A strong accent ring and tinted
  highlight identify focused to-do rows and the To-do toolbar button (including its count),
  even with the panel closed. Linked session/worker rows retain the quieter association
  cue while that Project Chat is the focused conversation. These cues are distinct from
  keyboard focus, attention and navigation selection and never wake work. Explicit task
  focus reveals the latest attributed transcript message through shared message navigation;
  background updates and composer focus never repeat the navigation.
  User context deltas coalesce in the Project record; read-only send preparation copies
  them into the existing recoverable input. A bound receipt is acknowledged only after
  Pi Durable has placed that input in originals, not on preparation or queue admission.
  Newer concurrent edits invalidate an older receipt and remain pending (at-least-once
  context delivery, not exactly-once prose). View focus is excluded from these reminders and
  the system baseline; submitting a message never consumes focus. Message replies and the
  to-do row's reply action both add ordinary text attachments through the shared composer.
  The existing attachment preview, removal, submission snapshot, queue and failure restoration
  own their lifecycle, including normal attachment access. To-do attachments quote their
  identity, scope and item snapshot; no persistent selection reminder or parallel context
  queue is involved. Changing focus or editing the live to-do cannot rewrite draft or
  submitted context. A bounded baseline in Project Chat’s live system context also survives
  recreation/reset.
  Permanent Project Chat and Cake Chat group contiguous related conversation with a margin
  rail, labeling task switches rather than every message. A → B → A labels A again on return.
  Newly admitted human inputs start unresolved and ungrouped until early attribution;
  they never optimistically extend the preceding heading, status or rail.
  This also applies to shared-list side chats forked from permanent chats, not ordinary
  coding-session task management. A stable instruction asks the main conversational agent
  to emit a hidden `<cake-todo>` JSON prefix before any visible response text, with the exact
  admitted `cake-turn` UUID and an open chat-scoped `todoId` or explicit JSON null.
  The admission token lives in Durable's existing input envelope and is exposed once on
  that input at the provider boundary. There is no utility attribution model, background
  classifier, classification-only tool round, extra inference, duplicate history payload
  or per-turn full-list fetch. Existing baseline/reminders and normal creation-tool results
  supply identities, including to-dos created during the response.
  Attached reply context is evidence, never an automatic assignment. Related follow-ups continue; genuine
  topic switches choose another identity or none, and returning to an earlier task labels it
  again. The provider-boundary adapter removes complete and split/incomplete metadata from
  live and persisted assistant text, validates complete prefix decisions against the exact
  consumed human inputs and current open list, and commits identity-only metadata beside
  Durable originals before forwarding the first visible response text. Normal to-do creation
  tools can precede the prefix, but prose must not. No separate classification dependency or
  timeout is introduced: missing/invalid metadata lets prose flow immediately, leaving the
  turn unresolved rather than hanging the reply. Once prose starts, unresolved turns cannot
  be assigned by a late trailer or a later tool round. This boundary is persisted too.
  Duplicate, invalid, completed, missing, incomplete and stale decisions remain unresolved,
  distinct from explicit none. An already committed prefix survives later failure or abort.
  Settled metadata and manual corrections cannot be overwritten by later or replayed results.
  Reload preserves unresolved and settled states; old settled associations are not reclassified.
  The static instruction changes the system prefix once on deployment; per-input UUID
  markers are stable across tool rounds and later requests. Prefixes add generation tokens;
  removing metadata from subsequent context may invalidate the cached suffix beginning there.
  This trades some prefix/cache cost for early headers, not another model request or a buffered
  answer; no zero-latency or zero-cache-impact guarantee is made. Local preparation reads only
  the active run's submissions/originals, not dialogue history, and performs metadata transactions
  without creating scheduled work.
  For explicit user-requested historical grouping repairs, the owning permanent chat exposes
  `messages.set-todo` with the original user entry ID and an existing chat-scoped to-do ID (or
  null). It updates settled identity-only attribution, never originals or the to-do itself;
  pending turns, non-user entries and entries outside the owning conversation are rejected.
  Known incoming session/subagent/exact-message associations are projected without a model call.
  Task-switch headings read the current to-do title and completion state live, without a
  status subtitle, and sit above their messages,
  with a modest outdent from the centered reading column, bounded by the transcript's left inset,
  without a border alongside the heading. The continuation rule begins below
  the complete title heading at every width. Wrapping headings retain their height
  in the reading flow, and consecutive sections leave a gap in the rule. Wide artifacts/widgets
  break the rule, not the heading. Revealing a task inspects its pane row without selecting
  view focus or attaching next-message context. Ordinary Project Sessions and secondary chats retain per-result controls.
  Their incoming message or source cards whose session, subagent or exact-message links
  match a to-do keep their association row visible, including historical updates, requests,
  batched completions and collapsed disclosures. The row renders the projected list item
  (title and open/done, whether changed by the user, an agent tool or session resolution)
  and toggles through the same user done/reopen mutation as the pane. Exact-message links
  match their original, not every message from that sender. Removing an item removes its
  association rows. Project Sessions and secondary chats reuse their owning Project/parent
  list without opening or waking Project Chat. Every incoming card is one SessionMessage
  summary row whose Done checkbox names its to-do; batching, source ownership and
  lifecycle remain unchanged.
- **Global Cake Chat to-dos** reuse the same schema, tools, baseline and pane, stored as one
  separate application-level list (`cakeChatTodos`, scope `CAKE_CHAT_TODO_SCOPE`) rather
  than inside any Project. Its links may target sessions, workers and messages in any
  registered Project; its resolution join uses each family's root regardless of Project.
  Project Session ownership is unique across all lists, including done items; one to-do
  may own many sessions. Automatic creation reuses an existing owner, normally the
  Project's automatic item, rather than also adding a global item. Create/update/batch
  ownership checks share the serialized application transaction; conflicts name existing
  IDs and scopes. Sources are citations, not ownership; side chats/subagents are unchanged.
  Historical duplicate links remain readable/editable without destructive migration:
  additions that conflict are rejected, ambiguous automatic bookkeeping reports every owner,
  and only intentional association edits resolve duplicates. Session resolution reconciles
  both the session's Project list and this
  list; lifecycle user-change reminders reach it only for sessions it links. The renderer
  projects it from the application-state stream into `CakeChatTodoList`.
- **Conversation navigation**: `SessionLayoutStore` owns one focused conversation and
  backward/forward visits within each Project/global Cake Chat workspace. There are
  no independent conversation splits or neighbor geometry. Project Chat retains its
  canonical Cake Chat identity, registry, transcript, draft and reading position.
  `AppShellStore` owns the selected workspace and optional Settings/artifact-library
  cover; visible selection derives from that workspace's focused conversation, never
  a separately persisted session identity. `NavigationStore` coordinates workspace
  changes and window visits. Covering/uncovering does not create a visit. Project
  rail activation opens Project Chat in Chat mode without resetting its runtime.
  The Go up one level shortcut (`Mod+Shift+H`) and `app.home` traverse exactly one
  ownership edge: child Session → immediate parent, root Project Session → owning
  Project Chat, Project Chat → global Cake Chat, and global Cake Chat → no-op.
  Side chats and public Subagents return to their actual conversation owner;
  Automation Sessions use their explicit Project/global context. Missing immediate
  owners do not fall back to a higher ancestor. The app-wide companion has no
  declared parent and is a no-op. Navigation preserves drafts and transcript state. The persisted hotkey action ID remains `return-to-project-chat`
  so customized bindings retain their assignment; neither it nor `app.home` retains
  the former direct-home behavior.
  `ConversationNavigatorStore` projects real Project Session grouping and family
  ancestry into the scoped Sessions source list. Independently launched task/worktree
  sessions remain there, including context forks. Each conversation's speech-bubble
  header menu lists its direct Side chats first and private Subagents second; neither
  is duplicated in Sessions. Released worker history remains navigable in that menu.
  Metadata-only catalog observation discovers cold ownership without hydrating transcripts.
  `DiscussionNavigationStore` retains visited public Discussion identities and reuses
  existing keyed Discussion/worker Stores and canonical conversation Models for actual
  focus. The displayed `SideChatStore.target.navigationTarget` is the canonical
  secondary selection for the center, breadcrumb and `app.state`; it never exposes
  a private worker Pi identity. Ordinary selected secondary chats replace the center,
  while detached/drop-down chat hosts retain their own existing accessory behavior.
  Header artifact libraries keep their existing materialized owner authority and
  explicitly name that owner during secondary focus; inline secondary artifacts keep
  their existing conversation capabilities. `app.workspace` reads/changes the same
  accessory Store as the UI, with existing agent-navigation permission for changes.
  Navigation snapshot migrations v1 → v3 restore old selection authority and Project
  Chat identity; v3 → v4 retains all old pane histories, focuses the previously focused
  conversation, and discards obsolete split geometry. Drafts/read positions remain
  conversation-owned. Child/fork launches default to background; `open: true` selects
  their ordinary conversation, never creates another pane.
- **Agent session navigation** uses `sessions.open` through the invoking renderer’s
  existing application-control gateway and `NavigationStore`. Project Session targets
  are validated against the catalog; ordinary focused-conversation/history policy applies,
  including retaining an already-selected target. `SettingsStore.agentNavigation` owns the
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

Model-presented content is data. Explicitly authored artifact runtime logic is trusted
host code accessed through validated Cake commands, not an artifact capability-grant
system; technical worker/frame isolation still applies.

Remote access assumes trusted users with multiple views. Desktop sharing can gate its
whole listener with Google sign-in and a server-enforced account allowlist; approved
clients still have full backend authority. Listeners without this option, including
standalone hosting, require private access or an independently authenticated proxy.
Host/Origin validation alone is not authentication. Opt-in external local MCP is
a full-control authenticated client: a loopback-only Effect Streamable HTTP server
exposes the canonical Cake operation definitions through one `cake` tool in
global Cake Chat's context, including its ordinary session gateway. Full-control
invocation bypasses model-facing catalog curation, not domain validation;
ordinary agent catalogs keep their existing curation. There are no MCP-specific Project or command
allowlists. A private persisted bearer token is required on every request;
existing domain validation, approval and host-capability checks remain authoritative.
Configuration changes restart the MCP listener, not agent execution. This uses
Cake's command contracts rather than exposing the renderer RPC protocol. See
[local MCP setup and limitations](../../README.md#local-mcp-access) and the remote
[host guide](../development/headless-backend.md#security-and-data-isolation).

- Artifacts and blocking requests cross bounded, validated protocols. Generated
  HTML/React executes in an opaque-origin sandbox with restrictive CSP, without direct
  Node, Electron or parent DOM access. Artifact views and independent backend logic
  use the canonical validated Cake-command bridge for trusted host functionality;
  documents/images do not acquire executable runtimes.
  Published widget HTTP responses enforce the sandbox even on direct navigation;
  intended Cake operations continue through the hosting surface's validated bridge.
- Session Plugin state is main-owned; sandbox-local React state is mount-local.
  Hiding a plugin is a user preference, not deletion or permission to reopen it.
- Registering a Project is the only approval Cake asks for. Cake answers Pi's
  project-trust question itself, so every registered Project, its managed worktrees
  and the home directory load their project-local Pi settings, skills, extensions
  and MCP without a separate prompt.
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
