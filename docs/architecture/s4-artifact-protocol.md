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

Full artifacts are global lineages projected into a Cake Session's accessory
panel through an explicit session or Session Family link. The panel opens from
that session's header, not from a permanent application-wide workspace and not
by replacing the transcript. Creating a new artifact automatically opens the
panel and selects that artifact; later updates may refresh the selected artifact
without stealing focus. The originating assistant message renders a compact
`Artifact created · <title>` reference that opens the artifact rather than a second
copy of its contents. The selected-artifact surface uses one quiet navigation row
for the collection, previous/next traversal, fullscreen, and close actions; the
artifact content is not wrapped in repeated titles, status headers, or source
controls. The durable pointer records the originating assistant entry
and tool call, so the reference appears only while that assistant message is on the
active Pi branch. Readable fallbacks remain in Cake's artifact repository and
exact-revision projection; they are not copied into the pointer or automatically
injected into Pi context.

The panel is session-scoped rather than branch-scoped. Selecting another Pi
session-tree branch, restoring an earlier branch, or running tool compaction does
not move, clone, or re-create artifacts. These operations may change which transcript pointers are visible, but effective
session/family links and stable lineage identities remain unchanged.

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
  to `~/.cake/state/artifacts`) as SHA-256-addressed JSON blobs. One atomically
  replaced, versioned catalog manifest indexes global lineages, all revisions,
  and session/family links. Lineage IDs are global; revisions begin at one and
  advance exactly one step through `expectedLatestRevision` compare-and-swap.
- Stable references are `cake://artifact/<lineage-id>` and exact
  `cake://artifact/<lineage-id>@rN`. A link itself appends no Pi entry and copies
  no payload. Current `cake.artifact/v1` transcript pointers retain exact
  lineage, revision, digest, title, kind, stable/exact refs, and provenance only;
  persisted legacy pointers with inline fallback are decoded solely for migration,
  display correlation, and reachability. Pi never receives a second Cake-owned
  transcript.
- Renderer `Artifact` instances are disposable projections of validated
  repository records. Session snapshots hydrate current records; a focused
  artifact observer applies live repository updates from the existing native
  event stream directly to loaded renderer Conversation Models. Pending response ownership,
  cancellation, and routing remain in a focused renderer artifact workflow
  Store and the main artifact domain operations above `CakeSessionRuntimes`.
- The catalog records explicit links to a Cake Session or Session Family. A link
  either follows the lineage's latest revision or pins one exact revision. Family
  creation workflows automatically create a family link; standalone fork policy
  may pin refs visible at the fork point. Hydration reads catalog links directly
  rather than reconstructing associations from transcript content.

## Branches, forks, families, and revision selection

Changing Pi branches or compacting tools does not alter artifact links or create
revisions. A family-linked lineage is effectively linked to every family member,
and any such session may publish its next revision; there are no owners,
permissions, or private mode. A follow-latest link advances as the lineage does.
A pinned link remains at its exact revision.

Fork and family workflows create links, never payload copies or ownership
transfers. A point-in-time fork can pin the exact revisions established at its
selected entry. Creating an artifact while operating in a Session Family instead
links the new lineage to the family so current and future members share it. Those
workflow operations are layered above storage; the repository only validates and
atomically records explicit links.

## Deletion and garbage collection

Resolving, restoring, changing branches, compacting tools, or merely unloading a
renderer projection never deletes artifact data. Permanently deleting a Cake Session or Session Family removes only links targeting
it. It does not mutate a lineage or revision.

A lineage is reachable when it has a direct link to a surviving session, a family
link whose family still has a surviving member, or a durable exact artifact pointer
anywhere in a surviving Pi transcript. The Artifact Library is not a retention
root. A reachable lineage retains every exact historical revision, and a blob is
removed only when no retained revision uses its digest.

Collection runs best-effort after permanent deletion commits and once at startup.
It uses Pi's `SessionManager` APIs rather than parsing JSONL, removes links to
proven-absent targets, and fails closed: incomplete or malformed transcript
enumeration, ambiguous session identity, operational failure, or concurrent
catalog mutation retains data. Initial publication and its first link are atomic;
other publish/link mutations serialize with collection through the artifact
storage semaphore. Disposable exact-revision projection caches are cleaned
independently and never retain or delete authoritative artifact content.

The maximum serialized tool input and response size is 1 MiB. Larger payloads
are rejected before display. This is the S4 answer to Q4: the durable location
is the Cake-home artifact repository, and the v1 inline protocol cap is
1,048,576 UTF-8 bytes.

## Tools and interaction lifecycle

The built-in `cake` gateway exposes session-contextual `artifacts.list`,
`artifacts.search`, `artifacts.history`, `artifacts.resolve-reference`,
`artifacts.create`, `artifacts.update`, `artifacts.restore`, `artifacts.link`, and
`artifacts.unlink` operations over global lineages and their effective links.
There is no payload-returning `artifacts.read` operation. Agents create
substantial Markdown documents directly without supplying duplicate fallback
text; Markdown is both the payload and readable fallback. They can also import
bounded workspace-relative files as immutable snapshots with a safe filename,
MIME type, byte size, and encoded content. Cake derives revision numbers. Create
begins a new global lineage at revision one and creates the appropriate session
or family link. Update keeps the stable lineage ID and publishes exactly the next
immutable revision using latest-revision CAS. Restore is the same publication
path with old content and `restoredFromRevision` metadata, producing `N+1`
rather than moving latest. Link and unlink append no transcript pointers.
Create, update, and restore each append one bounded exact-revision pointer without
payload or fallback content.

The `widgets.present` path remains the creation operation for substantial,
persistent visual explanations, including architecture and dependency views. Its
input is a semantic brief with audience, verified facts and relationships,
source references, bounded data, and a readable Markdown fallback. A restricted
specialist chooses the visual form and may combine prose and controls with
SVG/D3 inside the generated widget. Small diagrams remain inline
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

Only accepted source reaches existing widget artifact persistence. The Pi
pointer remains bounded metadata, while the fallback is available through the
exact-revision projection. Review turns use separate persisted restricted Pi sessions
with the same resolved model and full context; they do not share one transcript.
PNG image blocks are retained in those private Pi transcripts, not in the widget
artifact or the primary conversation. The screenshot covers a bounded preview,
not every interaction or possible delayed update; review is visual feedback,
not a guarantee of correctness or aesthetic quality.

React source is bundled as TSX and must default-export one component. Approved
imports are React and Cake's bundled D3 modules (`d3` or approved `d3-*`). Prefer
D3 submodule imports for smaller bundles; `import * as d3 from "d3"` is supported
for convenience. Generated source must not import CSS files.

These are capabilities of the same React widget, not a separate flow-widget
artifact type. The specialist can compose SVG/D3 diagrams with ordinary React
explanations, filters, source details, and accessible controls, or choose another
visual form entirely. Diagram geometry belongs inside an explicitly sized canvas;
surrounding content remains responsive normal-flow layout. Generation, repair and
visual review share these instructions. The
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

For agent inspection, main derives disposable read-only exact-revision filesystem
projections beneath
`$CAKE_HOME/cache/artifact-projections/v1/sessions/<session-id>/<lineage-id>/revisions/r000000NN/`.
Each projection contains bounded metadata plus canonical public files for the
artifact kind. It is never persistence authority, cannot publish, verifies its
files before reuse, and is safely rematerialized from the content-addressed
repository after modification or deletion. Artifact payloads and metadata are not
automatically injected into prompts or transcripts. Trusted static system guidance
directs agents to discover artifacts through `artifacts.list` or `artifacts.search`
and resolve an exact readable path through `artifacts.resolve-reference`. When the
session has effective direct or family links, one metadata-free system line notes
that linked artifacts exist. Widget projections contain only the public brief, metadata, and
fallback; generated source never enters them. Pasted unlinked refs require an
explicit link: temporary read leases are deferred until Cake has a truthful
lifetime and persistence owner for them.

Normal artifact presentation does not expose generated Source or a renderer-local
Repair control. User-requested repair is a durable `artifacts.update`: another
isolated Pi session receives stored source, stored brief, requested delta, and
bounded diagnostics as untrusted data. Cake compiles and visually reviews the
returned source through the same boundary before publishing the next revision.
The generated implementation never enters the primary project-session context.
Readable fallback remains required for explicit artifact inspection, export,
history, and render-failure recovery, but is not automatically injected into
transcript context or duplicated as routine viewer chrome. If a
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
