# S4 artifact protocol and ownership

Cake's durable rich-output contract is `cake.artifact/v1`. The blocking input
contract is `cake.request/v1`. Their shared Effect Schemas validate Pi tool
input, main-process persistence, Effect RPC, renderer Models, interaction
responses, and Cake Session pointers. Sharing protocol or storage machinery does
not make the two concepts the same product surface.

Unknown protocol versions, unknown kinds, and malformed payloads are hard
failures. Cake is greenfield and does not reinterpret unsupported protocols as
Markdown or carry compatibility behavior for superseded contracts.

## Product boundary and presentation

An artifact is an explicitly created, substantial, reusable deliverable: content
worth opening independently, revisiting later in the session, or exporting. The
payload's format does not decide whether it is an artifact. In particular,
ordinary Markdown conversation content stays inline, including Mermaid diagrams,
small tables, code fences, and other rich blocks. The agent should create an
artifact only when the deliverable, rather than its syntax, benefits from a durable
independent surface.

Full artifacts live in the owning Cake Session's accessory panel. The panel opens
from that session's header, not from a permanent application-wide workspace and
not by replacing the transcript. Creating a new artifact automatically opens the
panel and selects that artifact; later updates may refresh the selected artifact
without stealing focus. The originating assistant message renders a compact
`Artifact created · <title>` reference that opens the artifact rather than a second
copy of its contents. The selected-artifact surface uses one quiet navigation row
for the collection, previous/next traversal, fullscreen, and close actions; the
artifact content is not wrapped in repeated titles, status headers, or source
controls. The durable pointer records the originating assistant entry
and tool call, so the reference appears only while that assistant message is on the
active Pi branch. Readable fallbacks preserve production context for Pi.

The panel is session-scoped rather than branch-scoped. Selecting another Pi
session-tree branch, restoring an earlier branch, or running tool compaction does
not move, clone, or re-create artifacts. These operations may change which
transcript pointers are visible, but the owning session's artifact collection and
stable artifact identities remain unchanged.

Blocking requests are different. They stay inline at the active tool-call position
because the conversation cannot continue until the user submits or cancels them.
They do not enter the accessory panel or become reusable deliverables, even if the
current implementation persists and renders them through shared artifact
infrastructure.

## Authority and durability

- Cake owns artifact payloads and metadata. Pi remains the transcript and
  session-tree authority. Artifact revisions are immutable values; advancing an
  artifact writes a new revision and never mutates the bytes or digest of an old
  one.
- Electron main stores payloads under `$CAKE_HOME/state/artifacts` (defaulting
  to `~/.cake/state/artifacts`) as
  SHA-256-addressed JSON blobs. Atomic per-session metadata files point to the
  blobs. Artifact IDs are stable within a session and revisions must begin at
  one and advance exactly one step.
- Pi receives a `cake.artifact/v1` custom entry containing the artifact ID,
  session ID, revision, kind, digest, Markdown fallback, and—when created by an
  agent tool—the originating assistant-entry and tool-call IDs. It never receives
  a second Cake-owned transcript.
- Renderer `Artifact` instances are disposable projections of validated
  repository records. Session snapshots hydrate current records; a focused
  artifact observer applies live repository updates from the existing native
  event stream directly to loaded Session Models. Pending response ownership,
  cancellation, and routing remain in a focused renderer artifact workflow
  Store and the main artifact domain operations above `PiSessions`.
- Cake indexes the persisted Pi session reference in window state and records
  artifact session associations when Pi materializes a new persistent session ID.
  Hydration combines validated Pi pointers with that Cake index, so artifacts
  survive both renderer reload and application restart without guessing from
  transcript content. Tool compaction and session-tree navigation retain the same
  session association. A fork associates only the exact revisions referenced by
  Pi's source branch through the selected fork entry; those records are snapshots,
  so later source revisions or newly created source artifacts do not appear in the
  fork. Historical content-addressed blobs are retained even after an association
  is deleted because an older Pi transcript pointer may still become reachable
  through a later fork; metadata deletion remains scoped to the deleted session.

## Branches, forks, and revision inheritance

A Pi session-tree branch and a Cake Session fork have different artifact behavior.
Changing branches within one Pi Session never changes artifact ownership: the
session continues to expose its one artifact collection. Tool compaction likewise
keeps that collection in place and records no duplicate artifact merely because it
replays transcript text into a new root branch.

A fork creates a new Cake Session, so it receives a point-in-time inherited
artifact index. For each artifact lineage, Cake inherits the latest exact revision
established by a transcript pointer at or before the selected fork point; revisions
produced after that point are not inherited. Each inherited entry references the
exact source session ID, artifact ID, revision, and digest. It is immutable in the
fork and does not follow later source-session revisions.

Inheritance is reference-based, not a payload copy and not a transfer of ownership.
The fork may present the inherited artifact in its own session panel, labeled as
inherited, while the source keeps its original. Revising inherited content in the
fork is copy-on-write: Cake creates a fork-owned artifact lineage from the inherited
revision, leaving both the inherited revision and source lineage unchanged. A
source revision created later and a fork-owned revision therefore never overwrite
or silently merge with one another.

## Deletion and garbage collection

Resolving, restoring, changing branches, compacting tools, or merely unloading a
renderer projection never deletes artifact data. Permanently deleting a Cake
Session removes that session's owned and inherited index references. It must not
remove an immutable revision still referenced by another session, including a fork
that inherited it.

Repository garbage collection may remove a metadata revision and its
content-addressed blob only after no surviving session index, inherited reference,
or durable Pi transcript pointer can reach it. Shared blobs remain while any
reachable revision uses their digest. Collection is conservative and
restart-safe: uncertain reachability retains data, and interrupted collection
must not leave a live pointer without its payload. Once the last owning or
inheriting session and its transcript are permanently deleted, unreachable
metadata and blobs are eligible for collection rather than retained forever.

The maximum serialized tool input and response size is 1 MiB. Larger payloads
are rejected before display. This is the S4 answer to Q4: the durable location
is the Cake-home artifact repository, and the v1 inline protocol cap is
1,048,576 UTF-8 bytes.

## Tools and interaction lifecycle

The built-in `cake` gateway exposes session-scoped `artifacts.list`,
`artifacts.read`, `artifacts.create`, and `artifacts.update` operations. Agents
create substantial Markdown documents directly without supplying duplicate
fallback text; Markdown is both the payload and readable fallback. They can also
import bounded workspace-relative files as immutable snapshots with a safe
filename, MIME type, byte size, and encoded content. Cake derives session IDs and
revision numbers. Create begins a new lineage at revision one, while update keeps
the stable artifact ID and publishes exactly the next immutable revision. List
and read do not append transcript pointers. Widget reads return the presentation
brief and fallback rather than generated implementation source.

The `widgets.present` path remains the creation operation for substantial,
persistent visual explanations, including architecture and dependency views. Its
input is a semantic brief with audience, verified facts and relationships,
source references, bounded data, and a readable Markdown fallback. A restricted
specialist chooses the visual form and may combine prose and controls with React
Flow and optional ELK inside the generated widget. Small diagrams remain inline
Mermaid when they are clearest in the conversation. User-requested widget edits
use `artifacts.update`; Cake privately applies the requested delta to stored source
and publishes only after compilation, rendering, and review succeed.

The gateway also exposes `interview.open`, which accepts one
`cake.request/v1`, persists it at the tool-call position, and waits for one
schema-validated response or cancellation. Its `view` is either a Cake-rendered
form definition or a sandboxed HTML/React widget. The form view is preferred for
ordinary fields; custom code is for genuinely visual interactions.

Only internal request records may use request mode. These are blocking requests,
not entries in the session artifact panel. In a form select, the
first listed option is the agent's recommended option and Cake selects it by
default; the user may choose another listed option or enter freeform text. A
pending request has a unique request ID and exactly one terminal settlement.
Values are checked in the renderer before transport and again at the Pi boundary.
Invalid values keep the request open. User cancellation, Pi abort signals, Cake Session replacement, session-runtime
Scope disposal, and loss of the final owning renderer connection all settle it
as cancelled. Late or mismatched responses are ignored.

The `/cake-artifacts` built-in diagnostic command exercises the same repository
and response route without provider credentials. It is used by the deterministic
Electron acceptance test.

## Trusted built-ins and untrusted HTML

The trusted renderer includes Markdown, immutable file snapshots,
sortable/filterable/selectable/exportable tables, Mermaid diagrams,
schema-defined forms, media, diffs, HTML frames, and sandboxed generated widgets. Every surface retains its Markdown fallback, and
session export concatenates those fallbacks into a readable Markdown document.
Historical persisted architecture records are decoded only at the storage-read
boundary and projected as their mandatory Markdown fallback; their immutable
blobs, digests, metadata identity, and Pi pointers remain unchanged.

Model HTML is never inserted into Cake's DOM. It is assigned to `iframe.srcDoc`
with an empty sandbox token set and a document CSP that denies scripts, network,
forms, navigation, base URLs, and all resources except inline styling plus
explicit data media. The frame has no Node integration, Electron bridge,
same-origin parent privilege, popups, downloads, or top-navigation grant.
Mermaid output is also displayed in an empty-sandbox frame after Mermaid's
strict-security render step.

Built-in media accepts HTTPS or type-matching data URLs only and sends no
referrer. Raw Markdown continues to disable raw HTML through the existing
Cake-owned Markdown component.

## Delegated inline widgets and repair

The primary agent creates a one-off visual explanation with the non-blocking
`widgets.present` Cake operation. Its tool input contains a stable message-scoped ID, title,
self-contained presentation brief, required data, and readable Markdown
fallback. The primary agent does not author React or HTML. The brief remains in
the Pi transcript, while the generated implementation does not enter the
project session's model context.

Cake checks that the active configured model is available, authenticated and
supports image input, then starts a hidden, persisted Pi session with tools,
extensions, skills, context files and project trust disabled. That agent returns
one React component from the untrusted brief. Electron main compile-checks it and
loads the compiled sandbox document in a fixed-size, main-owned hidden offscreen
`BrowserWindow` with deterministic artifact-panel dimensions. The host waits for
the same bounded ready/runtime protocol used by normal widget display, then captures
only its opaque-origin sandbox iframe with `webContents.capturePage`. Capture
lifetimes are serialized process-wide so one candidate cannot capture another's
pixels. The host is never associated with a renderer session, composited into a
user's Cake window, or otherwise shown in the application.

The frame reports readiness after its bounded font/layout-settle policy. A restricted
specialist receives the
PNG, source, brief and bounded diagnostics. It returns `ACCEPT_CURRENT` or complete
replacement source. At most two replacements are permitted across compilation,
runtime and visual repairs combined. Every successfully rendered candidate,
including the final replacement, receives screenshot review. Cancellation and
capture/provider infrastructure failures stop the operation rather than consuming source-repair
attempts. Hidden windows and transient compiled tokens are released on settlement.

Only accepted source reaches existing widget artifact persistence and the Pi
pointer/fallback path. Review turns use separate persisted restricted Pi sessions
with the same resolved model and full context; they do not share one transcript.
PNG image blocks are retained in those private Pi transcripts, not in the widget
artifact or the primary conversation. The screenshot covers a bounded preview,
not every interaction or possible delayed update; review is visual feedback,
not a guarantee of correctness or aesthetic quality.

React source is bundled as TSX and must default-export one component. Approved
imports are React, Cake's bundled D3 modules (`d3` or approved `d3-*`),
`@xyflow/react`, and `elkjs/lib/elk.bundled.js`. Prefer D3 submodule imports for
smaller bundles; `import * as d3 from "d3"` is supported for convenience.
React Flow's required package stylesheet is embedded automatically in the
sandbox document when imported; generated source must not import CSS files.
React and ReactDOM peer dependencies share the entrypoint's instances. ELK uses
its bundled browser distribution without a remote worker URL.

These are capabilities of the same React widget, not a separate flow-widget
artifact type. The specialist can compose an actual React Flow diagram with
ordinary React explanations, filters, source details, and accessible controls,
or choose another visual form entirely. Diagram geometry belongs inside an
explicitly sized canvas; surrounding content remains responsive normal-flow
layout. Generation, repair and visual review share these instructions. The
ordinary `widgets.present` path performs automatic rendered screenshot review;
viewing an existing widget does not trigger capture. Blocking request widgets
remain separate interactions and do not automatically run this generation-only
review policy.

The widget runs in an `allow-scripts` iframe without same-origin privilege.
CSP blocks fetch/XHR/WebSocket (including D3's network helpers), while generic
widgets permit passive HTTPS/data image and media loads. Specialist instructions
require self-contained output with local data and no remote resources. The
sandbox exposes no Cake, Node, Electron, filesystem or parent-DOM access.
Runtime errors and frame height cross a token-tagged `postMessage` channel;
no general bridge is exposed.

Normal artifact presentation does not expose generated Source or a renderer-local
Repair control. User-requested repair is a durable `artifacts.update`: another
isolated Pi session receives stored source, stored brief, requested delta, and
bounded diagnostics as untrusted data. Cake compiles and visually reviews the
returned source through the same boundary before publishing the next revision.
The generated implementation never enters the primary project-session context.
Readable fallback remains required for transcript context, export, history, and
render-failure recovery, but is not duplicated as routine viewer chrome. If a
specialized renderer fails, the viewer displays that fallback directly.

Custom request widgets use that same compiler and sandbox with one additional
capability. HTML receives `cakeRequest.submit(value)` and
`cakeRequest.cancel()`. A React default export receives `submit` and `cancel`
props. Those functions emit token-tagged messages to the owning request host;
they do not expose Cake, IPC, credentials, files, or the parent DOM. The host
accepts messages only from its own frame and active compilation token, settles
at most once, and validates the submitted value against the request's declared
JSON Schema.

## Verification

Deterministic tests cover protocol versions, input limits, unsafe media,
response schemas, widget generation and cancellation before persistence,
historical architecture fallback migration and fork-pointer verification,
content addressing, revisions, hydration, Markdown export, driver correlation,
duplicate/late responses, session replacement, table and form interaction, and
the empty-sandbox/CSP boundary. The Electron smoke covers
table sorting, a structured form round trip acknowledged by revision update,
HTML isolation, Mermaid rendering, and application-restart hydration.
