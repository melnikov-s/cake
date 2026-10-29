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
- Transcript scroll ownership belongs to the reader. One owner,
  `src/renderer/lib/transcript-scroll-owner.ts`, is the only writer of a shared
  `ChatTranscript`'s scroll position. It follows new content only while the
  reader is at the bottom; anywhere else it never scrolls for the reader and
  compensates every layout change (streaming, arriving messages, tools, cards,
  virtual measurement, resizes) so the row at the top of the viewport stays
  still. Anchors are stored in content coordinates, so compensation cannot undo
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
  input or a completed reveal stops index-navigation retries. Do not add
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
  Private workers, including Cake Chat investigators, retain their detailed history in
  Pi-owned session files. Cake checkpoints handle identities, exact capability grants,
  unfinished admissions and completion receipts, not a copy of that history. Only
  compact reports and provenance cross into the parent Conversation.
- Private subagents and workflow workers always keep Pi auto-compaction on, whatever the
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
  user-authored dedicated instructions are appended verbatim. Session assistants
  retain parent context and identity but initially inject only the gateway topic
  index, discovering operation contracts on demand rather than embedding schemas.
- Agent discovery follows list → inspect → bounded read. Lists return exact routing
  identities, short labels and selection-relevant metadata, not content, transcripts,
  full settings, file manifests or reports. Apply domain filters and deterministic
  ordering before pagination. New in-memory catalogs share `AgentListInput` (20 items
  by default, maximum 50) and `agentListPage`; `nextOffset: null` marks completion.
  Existing cursor-based, metadata-only discovery keeps its bounded protocol. Exact
  inspection returns full metadata; content reads are explicit and independently
  bounded. Pending and scheduled inputs expose short labels; `pending-info` and
  `scheduled-info` read one exact input in text slices. Queue mutations return counts,
  not message bodies; edit via read plus cancel/send rather than bulk dequeue.
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
renderer binding. Project Session, permanent Cake Chat, and session-assistant
gateways retain their distinct sender and task-input policies before dispatch;
family messaging and backend-direct creation/fork/worktree routes stay separate.
Thread bindings, closed state, message identities and settled outcomes are durable
Cake coordination metadata, never another transcript or execution queue. Inspection reports backend facts; window selection remains
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
- **Project Chat to-dos** are Project-owned ApplicationStorage data, projected through
  the existing Project catalog into `Project.todos`; `ProjectTodosStore` owns only
  local edits, disclosure and side-pane interaction. The To-do toolbar toggle selects
  the same accessory slot/width as side chat, with its existing narrow replacement
  and composer-focus restoration. Actual new Project Sessions get one linked item at
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
  Session restore never reopens items,
  and to-do completion never resolves, stops, deletes or merges sessions. ApplicationStorage
  publication drives the pane and Open count without loading/waking Project Chat.
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
  The pane derives one live order: items needing user input, unread non-active items,
  other non-active items, then active items (including active+unread), newest activity
  first within each group. Pending interviews (`waiting`) and recovery issues
  (`blocked`) take precedence even when another required session is running or unread.
  Required session links use the shared session activity authority;
  source links are context only. Activity is the latest item
  `modifiedAt` or linked session `modifiedAt`. Item creation and revision changes
  record the timestamp in ApplicationStorage; selection/read acknowledgement does not.
  Older saved items without timestamps use linked activity where available.
  Equal or missing timestamps break ties by ascending item ID. Open and Done
  sections and search preserve this order, reacting immediately to metadata changes.
  One metadata-index snapshot and family snapshot join a bounded page, with filename-only
  identity enumeration per directory, never per item.
  Tools default to title/id/state/revision rows and compact mutation receipts; content is
  disclosed by exact detail or opt-in detail only. Each item records its latest completion
  (revision and user/agent/sessions source). Requesting `done` on a done item is a no-op
  for state; a stale `done` edit whose only intervening change was that completion
  still applies its other fields, while any other intervening edit stays a revision
  conflict. Selection is removable next-message
  context, never a send action, and exists only while that Project Chat's To-do panel is open:
  closing the panel clears it (a recorded user change), and app startup clears any persisted
  selection because no panel is open then. Completion also clears selection atomically. A faint
  shared association cue on the selected to-do and its linked session/worker rows shows only while
  that Project Chat is the focused conversation with its panel open; it is distinct from actual
  navigation selection and never navigates or wakes work.
  User context deltas coalesce in the Project record; read-only send preparation copies
  them into the existing recoverable input. A bound receipt is acknowledged only after
  Pi Durable has placed that input in originals, not on preparation or queue admission.
  Newer concurrent edits invalidate an older receipt and remain pending (at-least-once
  context delivery, not exactly-once prose). Each input sent with an open selection includes
  its snapshot in that same context block. Successful admission consumes that selection in
  ApplicationStorage and the pane, without clearing a newer selection made during admission.
  Failed sends retain it. Automatic deselection does not acknowledge other pending reminders;
  those still wait for durable consumption. The shared transcript projects one compact pill
  from the durable input, independent of later selection or lifecycle changes. A bounded
  baseline in Project Chat’s live system context also survives recreation/reset.
  Permanent Project Chat and Cake Chat group contiguous related conversation with a margin
  rail, labeling task switches rather than every message. A → B → A labels A again on return.
  Each consumed human input schedules one SDK-owned background attribution task using the
  configured utility model immediately, independently of the conversational response.
  Selection is evidence, never an automatic assignment. A null decision is reconsidered after
  the response only if new to-do IDs appeared during it, so newly created tasks can be matched.
  Missing utility configuration is reported without a conversational-model fallback.
  The request selects an existing to-do or null; it never creates tasks or changes agent context,
  and does not block the response. The prior human turn's settled attribution is evidence for
  model-decided continuity: related short replies stay with their discussion, while genuine
  task/scope switches choose another item or null (for example PDF resizing → managing all
  completed sessions). No topic-matching heuristics or sticky task fallback override decisions.
  Identity-only attribution lives beside Durable originals, not in another transcript. Explicitly
  pending attribution provisionally retains the current presentation section; a settled null,
  invalid or unavailable attribution ends it and leaves the turn ungrouped.
  Known incoming session/subagent/exact-message associations are projected without a model call.
  Task-switch headings read current to-do title/status/state live and sit above their messages,
  with a modest outdent from the centered reading column, bounded by the transcript's left inset,
  without a border alongside the heading. The continuation rule begins below
  the complete title/status heading at every width. Wrapping headings retain their height
  in the reading flow, and consecutive sections leave a gap in the rule. Wide artifacts/widgets
  break the rule, not the heading. Revealing a task inspects its pane row without selecting
  next-message context. Ordinary Project Sessions and secondary chats retain per-result controls.
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
  Sessions it creates get one linked item in its list in addition to their Project's
  automatic item. Session resolution reconciles both the session's Project list and this
  list; lifecycle user-change reminders reach it only for sessions it links. The renderer
  projects it from the application-state stream into `CakeChatTodoList`.
- **Conversation navigation**: pane layouts own the focused session and pane-local
  histories within the Project Session and Cake Chat/Project Chat workspaces.
  `AppShellStore` owns the selected workspace and optional Settings/artifact-library
  cover; its visible selection and retained conversation are derived from that
  workspace's focused pane, never separately persisted session identities.
  `NavigationStore` coordinates workspace changes and window visits. Window visit
  history and pane-local history remain distinct; covering/uncovering a workspace
  does not create a visit. The renderer navigation snapshot v1 → v2 migration
  retains existing layouts (their focus wins over conflicting old shell IDs) and
  seeds only missing layouts from old shell selection before mounting.
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
