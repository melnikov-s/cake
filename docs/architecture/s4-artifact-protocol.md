# S4 artifact protocol and ownership

Cake's durable rich-output contract is `cake.artifact/v1`. Its Effect Schemas
validate Pi tool input, main-process persistence, Effect RPC, renderer Models,
and Cake Session pointers. [Interviews](./interviews.md) are a separate primitive
with their own contract, operation, RPC, transcript metadata, and session-owned
Stores. They do not use the artifact repository or artifact events.

Unknown protocol versions, unknown kinds, and malformed payloads are hard
failures. Cake is greenfield and does not reinterpret unsupported protocols as
Markdown or carry compatibility behavior for superseded contracts.

## Product boundary and presentation

An artifact is an explicitly created, reusable deliverable: content worth opening
independently, revisiting later in the session, or exporting. The payload's format
and length do not decide whether it is an artifact. Ordinary Markdown conversation
content stays inline, including Mermaid diagrams, small tables, code fences, and
other rich blocks.

Investigations, explanations, ordinary implementation details, progress, and reports
remain in chat by default. Text/Markdown artifacts require an explicit user request,
with one exception: a spec may become a text artifact when it serves as a shared,
durable reference that the session can read after compaction or child sessions can
read for coordinated implementation. Shared-reference usefulness—not length,
formatting, or merely being an investigation—is the purpose of these artifacts.
This policy does not restrict non-text visual artifacts or explicitly requested
file deliverables. Maintained project documentation still belongs in the repository.

Full artifacts are global lineages linked to a Cake Session or Session Family.
The originating assistant publication renders one exact-revision artifact surface
inline, expanded by default, with a Collapse/Expand control and no separate
`Open artifact` action. All artifact kinds use their existing `ArtifactHost` renderer.
Creating or updating an artifact refreshes the catalog without opening a browsing
surface. Cake Chat and Project Session headers use the same `ArtifactCatalogMenu`
popover. Both headers show their linked-artifact count and effective session/family
list. Selecting a list item closes the popover and opens that artifact in an isolated,
resizable side pane at the linked revision, keeping the conversation alongside it
when space permits. The pane belongs to that conversation and closes on navigation.
The explicit `Browse all artifacts` action opens the shared Artifact Library.
Browsing never opens automatically on publication.
Ordinary Markdown artifact links remain prose links. A standalone
`![Title](cake://artifact/<id>@rN)` paragraph renders an expanded inline artifact
when that exact revision has no publication surface in the conversation. If the
publication already renders that exact revision, the redundant embed is omitted;
other revisions remain distinct. The isolated pane and shared library reuse the same
artifact detail workflow for revision history, references, link management, and fullscreen presentation. The durable pointer records the originating assistant entry
and tool call, so the reference appears only while that assistant message is on the
active Pi branch. Readable fallbacks remain in Cake's artifact repository and
exact-revision projection; they are not copied into the pointer or automatically
injected into Pi context.

The header's linked-artifact list is session-scoped rather than branch-scoped. Selecting another Pi
session-tree branch, restoring an earlier branch, or running tool compaction does
not move, clone, or re-create artifacts. These operations may change which transcript pointers are visible, but effective
session/family links and stable lineage identities remain unchanged.

Interviews stay inline at their originating tool-call position because the
conversation waits for submission or cancellation. They never become reusable
artifacts or enter the artifact catalog. They share only presentation primitives
and widget compilation/sandbox infrastructure with artifacts.

## Authority and durability

- Cake owns artifact payloads and metadata. Pi remains the transcript and
  session-tree authority. Artifact revisions are immutable values; advancing an
  artifact writes a new revision and never mutates the bytes or digest of an old
  one.
- The backend stores payloads under `$CAKE_HOME/state/artifacts` (defaulting
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
  repository records. The declared [Conversation contract](./s1-session-contract.md#conversation-observation)
  keeps artifact snapshots and updates in focused artifact projections, not
  Conversation Models. Exact payloads belong to the shared Artifact Catalog Model;
  transcript pointers identify inline publication surfaces without transferring
  payload ownership. Library operations remain in the renderer artifact workflow
  Store and backend artifact domain operations.

  Documentation clarification: this paragraph formerly described session snapshots
  and artifact events populating Conversation Models, contrary to that contract
  and this guide's Artifact Catalog ownership below. The wording is aligned to the
  declared contract; this documentation-only pass does not verify or claim an
  implementation migration.

- The catalog records explicit links to a Cake Session or Session Family. A link
  either follows the lineage's latest revision or pins one exact revision. Family
  creation workflows automatically create a family link; standalone fork policy
  may pin refs visible at the fork point. Hydration reads catalog links directly
  rather than reconstructing associations from transcript content.

## Message-board artifacts

**Workboard** (`message-board`) is a specialized artifact kind, automatically linked to a Session Family. Board-facing language calls these sessions a workgroup and its members; this does not change the underlying session-creation hierarchy. Its immutable revision-one payload identifies the family; it is a descriptor, not a snapshot of the evolving log. Artifact stable/exact references resolve that descriptor. Ordered entries are individually persisted under the artifact repository's `boards/<lineage-hash>/entries` directory, and compact per-entry/per-session first-notified/read receipts are stored separately. Appending does not rewrite earlier entries, copy the entire log into new artifact revisions, or change content revisions when someone reads. Generic replace/restore is refused; corrections are new entries referencing an earlier sequence.

The existing library shows a distinct type/icon and recent descriptions, and the artifact viewer provides ordered, paginated descriptions, expandable bodies and on-demand receipt details. Its human browsing operations do not mutate agent receipts. There is no separate chat, sidebar section or swarm dashboard. Board data shares artifact reachability and garbage collection. See the [family contract](./session-family-contract.md#shared-workboard) for tools and reminder semantics.

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
anywhere in a surviving Pi transcript. The permanent Cake Chat is a surviving
session independently of regular Pi session files, so its direct links are retained.
The Artifact Library is not a retention root. A reachable lineage retains every exact historical revision, and a blob is
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
`artifacts.search`, `artifacts.history`, `artifacts.resolve-reference`, `artifacts.preview`,
`artifacts.create`, `artifacts.update`, `artifacts.replace`, `artifacts.restore`,
`artifacts.link`, and `artifacts.unlink` operations over global lineages and their effective links.
There is no payload-returning `artifacts.read` operation. Agents create
substantial Markdown documents directly without supplying duplicate fallback
text; Markdown is both the payload and readable fallback. They can also import
bounded workspace-relative files as immutable snapshots with a safe filename,
MIME type, byte size, and encoded content. Cake derives revision numbers. Create
begins a new global lineage at revision one and creates the appropriate session
or family link. Update and replace keep the stable lineage ID and publish exactly
the next immutable revision using latest-revision CAS via `expectedRevision`.
Update accepts targeted Markdown `edits`, each with non-empty `oldText` and a
`newText` replacement (empty for deletion). It invokes Pi's public `createEditTool`
with in-memory read/write operations over staged artifact bytes, not a Cake-owned
matching algorithm. Pi owns matching, uniqueness, overlap checks, limited
whitespace/typography normalization, BOM and line-ending preservation, and no-op
rejection. All edits match the same original revision, not intermediate results.
Invalid, unchanged, or cancelled edits publish nothing. Artifact projection files
are never rewritten; Cake publishes the staged result through its existing
revision/CAS boundary. Replace accepts the complete Markdown document, a replacement
workspace-relative file path, or widget revision instructions.
Stored revisions remain complete immutable snapshots; agents
must not edit projection files directly. Restore is the same publication
path with old content and `restoredFromRevision` metadata, producing `N+1`
rather than moving latest. Link and unlink append no transcript pointers.
Create, update, replace, and restore each append one bounded exact-revision pointer without
payload or fallback content.

The `widgets.present` path remains the creation operation for substantial,
persistent visual explanations, including architecture and dependency views. Its
input is a semantic brief with audience, verified facts and relationships,
source references, bounded data, and a readable Markdown fallback. A restricted
specialist chooses the visual form and may combine prose and controls with
SVG/D3 inside the generated widget. Small diagrams remain inline
Mermaid when they are clearest in the conversation. User-requested widget edits
use `artifacts.replace`; Cake privately applies the requested delta to stored source
and publishes only after compilation, rendering, and review succeed.

The separate `interview.open` operation is documented in
[Interview ownership and lifecycle](./interviews.md).

The `/cake-artifacts` built-in diagnostic command exercises reusable artifact
publication without provider credentials. It does not open interviews.

## Trusted built-ins and untrusted HTML

The trusted renderer includes Markdown, immutable file snapshots,
sortable/filterable/selectable/exportable tables, Mermaid diagrams,
media, diffs, HTML frames, and sandboxed generated widgets. Every artifact retains its Markdown fallback, and
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
the Pi transcript. Publication supplies the accepted review PNG as a native model-visible
image with its exact revision reference and digest. Generated implementation source is
available selectively through exact-revision file reads; it is not automatically injected.

Cake checks that the active configured model is available, authenticated and
supports image input, then forks a hidden, persisted Pi conversation from the
caller's captured ancestor path. The fork excludes sibling branches and later
parent messages, retains Pi's compaction/context edits, and cuts before an
unfinished assistant/tool-result batch. The explicit widget assignment is appended
to that complete prefix. Executable tools, discovered extensions, resource loading
and project trust remain disabled; inherited instructions do not grant capabilities.
Cake-owned inline hooks preserve inherited prompt sections, append restricted task
instructions, and reuse the existing fork-lineage provider cache-key policy across
the explicitly allowed project/widget session roots. Transcript and transport
identities stay independent; actual cache hits remain provider/prefix-dependent.
That agent returns one React component from the untrusted brief. Electron main compile-checks it and
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

Only accepted source and its matching review capture reach existing widget artifact
persistence. The PNG is stored as bounded base64 in the revision's `payload.preview`,
inside the same content-addressed JSON blob as source and brief. The revision digest
binds all of these bytes. There is no independent screenshot store or retention root.
The existing 1 MiB serialized artifact limit still applies, including the preview;
oversized publication fails instead of dropping the image. The Pi pointer remains
bounded metadata. Publication (including widget replacement and restore) supplies the
stored capture as a native image tool-result block, never base64 in text/details.
The user sees the live interactive widget; that rendering is distinct from the image
actually supplied to the agent.

Generation, repair and visual review continue the same persisted restricted Pi branch
with the same model and inherited context. All review image blocks, including rejected
candidates, remain in that private Pi transcript under existing session retention.
Publication does not copy branch history, review commentary, or rejected images into
caller context. Native publication/preview image blocks are also retained by Pi in the
caller's ordinary tool-result transcript under its existing session lifecycle; artifact
blob collection does not independently delete those transcript copies. The accepted capture uses the existing hidden Electron host and bounded
layout-settle policy; no extra capture is taken at publication or retrieval. It covers
one bounded initial state, not every interaction, theme, viewport, or delayed update.
Review is visual feedback, not a guarantee of correctness or aesthetic quality.

The accepted PNG follows artifact retention and garbage collection: a reachable lineage
retains every historical revision; unlinking alone is not deletion. Existing collection
removes unreachable content-addressed blobs after permanent deletion and at startup,
failing closed on uncertain reachability. Disposable projected PNG/source files follow
the existing session/lineage projection cleanup and integrity/rematerialization policy.
Cancellation, review failure, or a publication CAS conflict cannot mutate a prior
revision or replace its capture.

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

Inline disclosures mount a live renderer only while expanded. A focused window-owned
`InlineArtifactPreviewStore` owns per-mount expansion and read status; exact payloads
stay in the shared Artifact Catalog Model. Metadata resolution freezes stable embed
references to an exact revision for that mount. Reads deduplicate while active, ignore
stale/disposed results, and expose retry; collapse never changes artifact links or library
selection. Separate inline, library, and fullscreen mounts have independent ephemeral
React interaction state. Compiler/runtime failures retain the readable fallback.

Every widget receives the host's semantic color/font tokens before first paint through
a URL fragment, and live theme changes through a source- and token-bound message.
Changing themes does not change `src` or reset interaction state. Inline presentation
removes outer padding/background; the artifact library retains its framing. Content
height reports track both expansion and shrinkage (not the iframe viewport minimum),
including responsive reflow, and the host bounds them to 120–1200 CSS pixels. Generated
pages must not use viewport-dependent root heights. Review hosts without app tokens
use browser system-color defaults, not another Cake palette.

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
automatically injected into prompts. The accepted preview is the explicit native-image
exception at widget publication and `artifacts.preview`; lists and resolution stay
metadata-only. Trusted static system guidance
directs agents to discover artifacts through `artifacts.list` or `artifacts.search`
and resolve an exact readable path through `artifacts.resolve-reference`. When the
session has effective direct or family links, one metadata-free system line notes
that linked artifacts exist. Widget projections contain `brief.json`, `fallback.md`,
`preview.png` when retained, and `source.tsx.txt` or `source.html.txt`. Source is inert
read-only text, not executed by projection; neither it nor private generation-session
provenance is automatically supplied to the agent. Pasted unlinked refs require an
explicit link: temporary read leases are deferred until Cake has a truthful lifetime
and persistence owner for them.

`artifacts.preview` requires an exact `@rN` reference and uses the same effective-link
resolver as ordinary artifact inspection. It returns exact metadata and the stored
native PNG image. Use a direct Cake tool call for native images; codemode's text/structured
result does not itself expose native image blocks. Alternatively resolve the exact
reference and read `preview.png` with an image-capable file tool. Historical snapshots
without a retained capture report an explicit unavailable error; there is no new render,
private-transcript recovery, latest-revision substitution, or mutation of old snapshots.

Before implementation, inspect the user-approved exact preview, not merely the originating
brief. Read source selectively for ambiguous layout or dynamic behavior, without importing
the generation conversation. After implementation, compare a real implementation screenshot
against that same approved revision and verify relevant interactions. Approval identifies
an artifact revision; it does not snapshot arbitrary user interaction state in a live widget.

Normal artifact presentation does not expose generated Source or a renderer-local
Repair control. User-requested repair is a durable `artifacts.replace`: a new
restricted descendant of the accepted artifact generation branch receives stored
source, stored brief, requested delta, and bounded diagnostics as untrusted data.
It retains the artifact branch's context rather than silently importing later
parent messages. Forking leaves the previous accepted revision's transcript
unchanged, including when a revision fails or loses a publication conflict. Cake compiles and visually reviews the
returned source through the same boundary before publishing the next revision.
The generated implementation enters agent context only through selective source reads.
Readable fallback remains required for explicit artifact inspection, export,
history, and render-failure recovery, but is not automatically injected into
transcript context or duplicated as routine viewer chrome. If a
specialized renderer fails, the viewer displays that fallback directly.

Custom interview widgets use that same compiler and sandbox with one additional
capability. HTML receives `cakeRequest.submit(value)` and
`cakeRequest.cancel()`. A React default export receives `submit` and `cancel`
props. Those functions emit token-tagged messages to the owning interview host;
they do not expose Cake, IPC, credentials, files, or the parent DOM. The host
accepts messages only from its own frame and active compilation token, settles
at most once, and validates the submitted value against the request's declared
JSON Schema.

## Verification

Deterministic tests cover protocol versions, input limits, unsafe media,
response schemas, widget generation and cancellation before persistence,
historical architecture fallback migration and fork-pointer verification,
content addressing, revisions, hydration, Markdown export, driver correlation,
table interaction and the empty-sandbox/CSP boundary. The artifact Electron smoke
covers table sorting, HTML isolation, Mermaid rendering, and application-restart
hydration. Interview response, cancellation, remount, and cleanup coverage is
separate.
