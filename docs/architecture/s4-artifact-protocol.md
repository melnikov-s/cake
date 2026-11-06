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
The originating assistant publication renders one linked artifact surface inline,
following latest unless the effective session/family link is pinned. It is expanded
by default, with a Collapse/Expand control and no separate
`Open artifact` action. All artifact kinds use their existing `ArtifactHost` renderer.
Creating or updating an artifact refreshes the catalog without opening a browsing
surface. Cake Chat and Project Session headers use the same `ArtifactCatalogMenu`
popover. Both headers show their linked-artifact count and effective session/family
list. Selecting a list item or opening a prose artifact link opens only that artifact
in the conversation’s shared resizable accessory pane, replacing to-dos or side chat
without opening the library. Pinned/exact references retain their revision; stable
references follow latest. The pane header’s fullscreen action expands the same live
content, preserving scroll and iframe/editor state; exiting fullscreen returns it to
the pane. Both views retain the existing conversation and artifact context. The global
artifact menu outside a conversation still opens selections in fullscreen.
The presentation belongs to its conversation and closes on navigation.
A message sent from an artifact sets that conversation's artifact target for the
message and subsequent messages until a new user message is sent outside that
artifact (explicitly clearing the target) or from another artifact (replacing it).
Closing the presentation alone sends no context change. Only the first outside
send after a targeted send emits a clear notice; fresh conversations, viewing
without sending, and subsequent outside sends do not. This transition is recovered
from Pi's existing branch/inbox or Durable input originals, not window visibility.
Revision metadata and exact references identify immutable content at submission, not fresh live content
on later turns; current revisions and mutable widget state require fresh reads.
Artifact metadata remains data, and target identity grants no additional access.
The explicit `Browse all artifacts` action opens the shared Artifact Library.
Browsing never opens automatically on publication.
Ordinary Markdown artifact links remain prose links. A standalone
`![Title](cake://artifact/<id>@rN)` paragraph renders an explicitly pinned inline
artifact, distinct from ordinary publication surfaces. Stable embeds without `@rN`
follow latest; a redundant stable embed next to a publication is omitted. Menu selections and the shared library reuse the same
artifact detail workflow; revision history, references, and link management remain in the library. The durable pointer records the originating assistant entry
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

## Global artifacts and independent logic

A **global artifact** is an artifact lineage with `global: true`, not an installed
app. This placement is an independent retention root for any kind, including
Markdown, files and images. Its lifetime does not depend on the creating session.
The existing Artifact Library can filter global placement; independent/fullscreen
opening reuses the same viewer. `artifacts.set-global` and `artifacts.delete` share
the UI's backend paths. Titles and optional descriptions are revision metadata;
ordinary authoring operations accept descriptions too.

`artifacts.globals` lists bounded global metadata. `artifacts.viewing` reports
visible references and the active reference for each live renderer connection,
including fullscreen, and identifies the calling session's bound window when one
exists. It does not infer "this artifact" from creator identity. Reports are
window-owned disposable projections, not persistence, retention or transcript
context. Disconnected windows disappear from discovery. Each report also includes
`navigation`: a disposable renderer-owned `{windowId,project,session}` snapshot.
Project identity is its canonical path/name; session identity/kind distinguishes
Project Sessions, Project Chat, global Cake Chat and automation sessions, with
explicit null for no selection. Mounted authored views receive this same snapshot
plus their `viewId` through `useArtifact().context` or HTML
`cakeArtifact.getContext()/subscribeContext(listener)`. Initial handshake and later
changes do not reload the view; unmount removes its subscriptions. Window facts
never substitute for an invocation's real caller or RPC connection.

An executable widget may declare `payload.runtime` with trusted JavaScript factory
source and semantic tool descriptions/input/output JSON Schemas. Agents discover
`artifacts.tools` and invoke `artifacts.call`; tools are not dynamically added to
Pi's toolbelt. Arguments and results are validated. UI `useArtifact().callTool`
and HTML `cakeArtifact.callTool` invoke the same backend handlers. Documents and
images have no executable runtime.

The independent backend runtime uses a long-lived QuickJS worker, not a hidden
browser or a Pi session. Factory closure state survives view disposal. Runtime
creation is lazy on current-view opening, tool invocation or a due schedule;
started workers remain until explicit stop/restart, deletion or backend exit.
Closing a view unmounts its DOM and emits an unmount hook without stopping logic.
Start/focus/blur/unmount/context/stop/delete hooks are meaningful backend events; historical
source previews do not activate another runtime. The opt-in `context` hook receives
initial and changed navigation only for mounted current-revision views, carrying
`navigation`, genuine `windowConnectionId` and scoped `viewId`; context observation
alone never starts a stopped runtime. Private lineage JSON persistence
is available through `data.read`/`data.write`; artifacts own its meaning and save
policy. Cleanup hooks are not a reliable final save boundary.

Runtime `cake(command,input)` and UI `cake.call(command,input)` use the validated
canonical backend Cake bridge, broad by default. Artifact-authored code is trusted
for host functionality, with process isolation and boundary validation rather
than capability grants or a permissions UI. Supported host commands include
filesystem read/write/list, scoped backend shell commands with explicit absolute
working directories, HTTP(S) requests and explicit-destination,
artifact-attributed chat input. Background calls have no inferred/creator session;
agent calls carry their actual calling session. UI-originated calls retain their
real renderer connection separately from a conversation link, including semantic
handlers called by an unlinked global view. Later background calls inherit neither
a prior window nor a creator session. Session-relative operations need a real
caller, and native/window operations still require their actual host.
This is Cake command coverage, not arbitrary access to Pi tools. See
[authoring](../development/global-artifact-authoring.md) for discovery and schemas.

`artifacts.runtime.publish` advances an existing widget's immutable revision with
new backend source/tools while retaining its accepted view. All source publication
paths refresh already-running logic, preserve saved data and refresh live views;
unopened runtimes stay lazy. A call retains its resolved revision until settlement.
The artifact owns any data-format change; Cake supplies no generic migration
framework. Synchronous self-directed runtime execution/control/publication through
the Cake bridge is rejected before side effects because the worker would wait for
its own serialized operation. This is an execution limitation, not a permissions
allowlist; read-only self-discovery, external calls and other artifacts remain
supported. A reload failure is visible in runtime status, not a claim that an
already-committed revision failed to publish.

Named deterministic artifact schedules live in the existing automation ledger and
worker. `artifacts.schedules.configure/list/remove` manage them without an LLM,
Pi session or scheduled conversation message. Due work resolves current source and
advances directly past now, producing one catch-up after backend restart rather
than replaying missed ticks. The backend must be running to execute. Latest
success/failure receipts are persisted. A due occurrence is consumed only on its
individual admission; a later due one-time handler paused by an earlier handler
remains due until resume. Focused execution invalidations refresh selected runtime
controls and errors after lifecycle/handler/schedule changes, without polling or
remounting the view. Pause stops logic and durably pauses
background work until explicit resume; opening, starting or restarting the view
never resumes paused schedules. Tools remain discoverable/callable while paused.
Deletion removes schedules, stops logic, attempts its cleanup hook, then deletes
only Cake-owned artifact data. It never deletes arbitrary outside files.

## Direct static HTML presentation

`html.present({ id, title, html, height? })` creates and presents a revision-one
`html` artifact in Project Sessions, Project Chat, and global Cake Chat. The
calling agent authors the HTML/CSS; no specialist generation, bundling, browser
opening, workspace file, or automatic screenshot review is involved.
The existing HTML iframe uses an empty sandbox and a restrictive CSP: scripts,
network requests, forms, and parent access remain disabled. Optional payload
`height` is an integer from 120 to 1600 CSS pixels; omission uses a 240px frame.
This is explicit geometry, not automatic content measurement.

Publication and the first scope link use the existing artifact storage workflow.
Regular Pi records its normal custom artifact pointer; Durable records successful
`html.present` metadata in its original tool result, which also reconstructs the
inline surface on history replay and result-only pages. Existing results can be
shown again with `artifacts.present`. Static publication supplies no model-visible
rendered pixels and must not be described as visual verification. Interactive
HTML/React remains the separate reviewed `widgets.present` workflow.

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
Global placement is an independent retention root. The Artifact Library's mere
visibility is not a retention root. A reachable lineage retains every exact historical revision, and a blob is
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
`artifacts.search`, `artifacts.history`, `artifacts.resolve-reference`, `artifacts.present`, `artifacts.preview`,
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

`artifacts.present({ reference })` shows an existing artifact in the requesting
conversation, including permanent Project Chat and global Cake Chat. It does not
require ownership or an open producing session. Permanent chats treat presentation
as an explicit link intent: resolve through existing effective-link authorization,
and only on `ArtifactNotLinked` establish a link through the existing global-link
policy. Other failures propagate; an existing link's selection is never changed.
Project Sessions continue to require an effective link before presentation.
Regular Pi appends a metadata-only `cake.artifact/v1` pointer with
`presentation: "selected-revision"`. Permanent chats retain exact metadata (including
digest) in their successful `artifacts.present` Pi Durable tool-result original;
the shared transcript projection recognizes only validated successful presentation
results, including when the originating call is on another history page. There is
no second transcript or renderer-only presentation event. Each call is an independent
inline surface, including repeated calls for an already-published exact revision.
The renderer pins that surface to the resolved exact source; stable input resolves
current source and exact input respects `@rN`. Widget instances still hydrate
current mutable lineage state, never a historical state snapshot. No generation,
publication, ownership transfer, provenance change, or state write occurs. After
any necessary first link, repeated presentation does not mutate links either. All kinds reuse `ArtifactHost`
and existing sandbox boundaries. This is user presentation, not a new screenshot
for the model; retained review images remain `artifacts.preview`'s responsibility.
Use this operation rather than regeneration or duplicate Markdown embeds when
the user wants to see an existing artifact again.

Catalog listing, detail, reference metadata, and paginated history use revision
metadata, not payload decoding. Publication records the optional title in revision
metadata. Catalog version four backfills titles from validated immutable blob
headers, verifying digests and identities without rewriting blobs or interpreting
historical payloads. In particular, unrelated pre-browser-output widget snapshots
must not make an ordinary link to a valid widget fail while loading the library.
Selected payloads still pass the full current artifact schema; unsupported
payloads are not reinterpreted or given a compatibility rendering fallback.

Choose widget operations by what changes, not by whether the user says "edit":

- `artifacts.present` displays an existing document without generating or publishing.
- `artifacts.state.read` plus `artifacts.state.update` edits document content in
  an existing data-driven widget. Its implementation owns validation and layout;
  state updates do not compile, invoke models, or create source revisions.
- `widgets.instantiate` creates an independent document from a loaded skill's
  prepared widget template (`template: <skill name>`) or a linked exact widget
  revision (`reference: <exact ref>`), plus explicit new JSON state. It reuses
  retained source/browser output and captures that new initial state without
  request-time generation or compilation. A skill template needs no prior artifact
  or editor link.
- `widgets.present` generates a new implementation from a semantic brief with
  audience, verified facts, bounded data, and readable fallback.
- `artifacts.replace` changes widget source/behavior (or content that an old
  implementation hardcodes). It compiles, renders, and reviews the new source.

A restricted specialist may combine prose, controls, SVG, and installed libraries.
Prefer data-driven implementations with document content in artifact state rather
than source literals. Small diagrams remain inline Mermaid when that is clearest.
Library-specific document formats and native layout remain in skills/widgets,
not Cake-specific diagram operations.

The separate `interview.open` operation is documented in
[Interview ownership and lifecycle](./interviews.md).

The `/cake-artifacts` built-in diagnostic command exercises reusable artifact
publication without provider credentials. It does not open interviews.

## Skill-supplied widget templates

A portable Pi skill may include `widget.json` next to `SKILL.md`:

```json
{ "language": "react", "source": "assets/editor.tsx" }
```

The generic session resource loader prepares these opt-in renderers before the
session accepts requests. Source must resolve inside the discovered skill's
canonical directory and fit the normal 1 MiB source bound. Preparation uses the
existing compiler and authorized widget package environment, retaining browser
output through the same content-addressed store as generated widgets. Missing
libraries or invalid templates produce an explicit error when requested; Cake
never installs packages, changes settings, or generates a substitute. Preparation
is internal bootstrap compilation, not a no-compilation-ever guarantee. Start a
fresh session after adding/changing a skill or its widget libraries.

The loaded skill name is the template key. Its instructions should include the
complete minimal `widgets.instantiate` call and scene/data format, so ordinary
creation needs only the skill read followed by that tool call. The calling agent
does not read renderer files, search for accepted editors, discover schemas or
packages, or write renderer code. No library-specific operation, dependency,
scene schema, or built-in skill is added to Cake. This mechanism applies equally
to React library editors and self-contained HTML widgets.

Template source is separate from per-document `initialState`. Every instance has
an independent global lineage and artifact-scoped state. A real initial-state
capture is retained and the normal publication pointer shows the live widget
inline. This is capture evidence, not model review or interaction verification.
The existing opaque sandbox, local resources, CSP and scoped state bridge are
unchanged. Native editing, persistence and reopening remain widget responsibilities.
A template has no invented generation conversation ID; a deliberate source/behavior
revision starts a new reviewed generation branch with the current source/state.

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
fallback, plus an optional `language: "react" | "html"` choice. React remains the default;
choose HTML explicitly for simple native-DOM interactions, small calculators, or compact
visualizations that need no component framework or installed libraries. Choose React for
component-heavy experiences, installed widget packages, and prototype-ui module manifests.
There is no automatic classifier or silent mode selection. Both are the existing `widget`
artifact kind, not static `kind: "html"` artifacts. The primary agent does not author React or HTML. The brief remains in
the Pi transcript. Publication supplies the accepted review PNG as a native model-visible
image with its exact revision reference and digest. Generated implementation source is
available selectively through exact-revision file reads; it is not automatically injected.

Cake checks that the active configured model is available, authenticated and
supports image input, then forks a hidden, persisted Pi conversation (the widget
side chat) from the caller's captured ancestor path. The fork excludes sibling
branches and later parent messages, retains Pi's compaction/context edits, and cuts
before an unfinished assistant/tool-result batch. The widget assignment, brief and
data are appended to that complete prefix as one user message.

The side chat exists so widget work stays out of the caller's context without paying
to re-read it, so it must reuse the caller's prompt cache. Its requests therefore
start with exactly the bytes of the caller's own next request: the inherited system
prompt sections and tool declarations are rebuilt unchanged, the thinking level is
inherited, and the fork-lineage provider cache key is reused across the allowed
project/widget session roots. Pi records any prompt or tool-declaration change as a
mid-conversation system update, and providers then re-read the entire inherited
conversation; the side chat never causes one. Cake keeps every inherited declaration
and replaces only what the tools do. `write` and `edit` change the operation's private
widget files, `read` reads those files or discovered skill resources, and every other
inherited tool refuses. Discovered extensions and project trust stay disabled;
inherited instructions grant no capabilities. A parent without `read`, `write` and
`edit` declarations, or without a structured system prompt, cannot host a side chat:
generation fails explicitly instead of running uncached.

The side chat writes source as files, one per tool call, so no single reply has to
carry the whole widget and the widget's size is bounded by the context window rather
than one reply's output limit: `widget/widget.tsx` (React or Session Plugin),
`widget/widget.html` (HTML), or `widget/chooser.tsx` plus five
`widget/options/<id>.tsx` and optional `widget/shared/<id>.tsx` (prototype-ui), and
`widget/state.json` for artifact state. Writing empty content removes a file. It
finishes with a reply that calls no tool. Cake assembles the files into the published
source; for prototype-ui it builds the module manifest and computes each module's
dependencies from its imports. A reply that stops at the model's output limit gets one
continuation in the same branch with written files kept; a second consecutive one fails
with "hit the model's output limit while reasoning". `widgets.present` streams the
phase and written files to the caller's live tool result while this runs.
Electron main compile-checks the assembled source and
loads the compiled sandbox document in a fixed-size, main-owned hidden offscreen
`BrowserWindow` with deterministic artifact-panel dimensions. The host waits for
the same bounded ready/runtime protocol used by normal widget display, then captures
only its opaque-origin sandbox iframe with `webContents.capturePage`. Capture
lifetimes are serialized process-wide so one candidate cannot capture another's
pixels. The host is never associated with a renderer session, composited into a
user's Cake window, or otherwise shown in the application.

The frame reports readiness after its bounded font/layout-settle policy. The same
side chat then receives the PNG and bounded diagnostics as its next user message. It
replies `ACCEPT_CURRENT` without changing files, or fixes the files with its tools.
Assembly and compilation errors are sent back the same way for the side chat to fix.
At most two replacements are permitted across compilation, runtime and visual repairs
combined; a review that neither accepts nor changes the files fails. Every successfully rendered candidate,
including the final replacement, receives screenshot review. Cancellation and
capture/provider infrastructure failures stop the operation rather than consuming source-repair
attempts. Hidden windows and transient compiled tokens are released on settlement.

Only accepted source, retained browser output, and its matching review capture reach
widget artifact persistence. Candidate state is isolated during generation and capture.
Changed candidate state commits atomically with publication using its observed live
state version; an unchanged candidate preserves concurrent live saves. The PNG is stored as bounded base64 in the revision's `payload.preview`,
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

### Reusing accepted widget implementations

`widgets.instantiate` requires a linked exact `reference` (`@rN`), a new `id` and
`title`, explicit JSON `initialState` (including explicit null when intentional),
and a readable `fallback`. It creates revision one of a separate lineage using
exactly the template's accepted language, source, generation-branch provenance,
and retained browser bytes. It never reads or copies the template's live state.
The new document is committed atomically at state version zero; ordinary lineage
ID collision and effective-link checks still apply.

The host opens and integrity-checks retained browser output, mounts it with the
supplied state in the existing ephemeral capture sandbox, and retains a fresh
initial-state PNG. It does not copy the template's preview or call generation,
compilation, package resolution, or an AI reviewer. This is new data in an
already accepted implementation, not acceptance of newly generated source.
Capture failure/cancellation publishes nothing; transient document tokens are
released. Runtime JSON normalization belongs to the widget, just as for other
live state edits. The capture proves one initial render, not all interactions.

An implementation must actually read artifact state for new data to affect it;
instantiation does not rewrite hardcoded source. Old implementations need an
explicit source revision to adopt data-driven behavior. Reopening/presenting
never silently rewrites an immutable implementation.

HTML generation writes `widget/widget.html` containing one complete
`<!doctype html><html><head>...</head><body>...</body></html>` document, with inline
CSS and browser JavaScript. It has no JSX, imports, external scripts/styles/fonts,
remote resources, npm packages, dependency resolution or bundling step. Native DOM,
SVG and browser APIs provide interaction. The existing compiler injects the same
sandbox runtime and scoped state bridge before authored scripts; the same mandatory
browser render, visual acceptance and retained-build integrity checks apply. Incomplete
documents and React files are assembly errors sent back to the side chat; they cannot
publish as generated HTML. The selected language holds through generation, repair and
visual replacements. `artifacts.replace` preserves the accepted revision’s
`payload.language`; it has no language-switch input. Source, language, brief, browser
output and accepted screenshot remain immutable revision metadata.

React source is bundled as TSX and must default-export one component. React is the
default runtime; other libraries are explicitly installed by the user in Cake's shared
widget-package environment, outside Cake's application dependencies and the user's
project. Settings and agent package operations manage this environment. Installation,
upgrade, removal, and subsequent runtime compilation require no application rebuild
or restart. Library knowledge belongs to ordinary Pi skills, not Cake tool catalogs.
An explicit dependency request authorizes installation; otherwise the agent asks first.

The compiler resolves installed packages and their transitive dependencies, keeping
React a singleton. Static CSS and media/font imports are bundled. The generic
`@cake/assets/<package>/<package-relative-directory>/` import exports a token-bound
URL base and retains that directory's resources for libraries that load assets at
runtime. Accepted output is a small digest reference to file-backed HTML and assets
under the artifact repository's browser-output store, not inline compiled bytes in
the 1 MiB tool/source payload. Opening accepted output binds a fresh token without
recompilation or an installed dependency. Referenced outputs follow artifact
reachability; package removal cannot invalidate an accepted revision.

These are capabilities of the same React widget, not a separate flow-widget
artifact type. The specialist can compose SVG or installed diagram libraries with ordinary React
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
stay in the shared Artifact Catalog Model. Reference links and inline previews share
metadata resolution through `ArtifactReferencePreviewStore` while mounted. It retains
only exact reference identity and loading/error status; mutable lineage titles and
links, plus revision metadata, normalize into the shared Artifact Catalog Model.
Stable embeds and ordinary publication
cards follow the latest published source, including already-open mounts. Publication
revision metadata is provenance, not a display pin. Explicit `@rN` embeds, pinned
session/family links, and deliberate history selections retain their selected source.
Source reloads hydrate the same lineage document; they do not reset persisted edits. Reads deduplicate while active, ignore
stale/disposed results, and expose retry; collapse never changes artifact links or library
selection. Separate inline, library, and fullscreen mounts have independent ephemeral
React interaction state, but share the lineage's live document state. Compiler/runtime failures retain the readable fallback.

Every widget receives the host's semantic color/font tokens before first paint through
a URL fragment, and live theme changes through a source- and token-bound message.
The host resolves explicit Light/Dark and follows OS changes when System is selected.
The public authoring surface is live semantic CSS variables plus host-owned
`html[data-theme="light"]`/`html[data-theme="dark"]` and CSS `color-scheme`, shared
by HTML and React. Widgets must consume variables directly, not freeze resolved
creation-time colors, override host tokens or independently follow OS media queries.
Cake prototypes use those live variables inside their frames too; another app's
intentional palette is not automatically recolored. See [agent guidance](../agent/artifacts.md#live-widget-theme).
Changing themes does not change `src` or reset interaction state. Inline presentation
removes outer padding/background; the artifact library retains its framing. Content
height reports track both expansion and shrinkage (not the iframe viewport minimum),
including responsive reflow, and the host bounds them to 120–1200 CSS pixels. Generated
pages must not use viewport-dependent root heights. Review hosts without app tokens
use browser system-color defaults, not another Cake palette.

The widget runs in an `allow-scripts` iframe without same-origin privilege.
HTML/React `target="_blank"` links (including dynamically rendered links) send
an `open-link` message with an absolute URL through the existing source- and
compilation-token-bound channel. The hosting view reuses its normal external URL
opener and scheme validation, or its conversation navigation for Cake artifact,
session, message and subagent references. Electron opens HTTP(S) links on the
viewing device; the browser host also supports mail links. This does not grant
popups, parent navigation, Node access or an opener. Downloads, same-frame links,
hash links and clicks already handled by authored code retain their normal behavior.
`window.open(url)` uses the same URL-open operation and always returns `null`;
target/features are not window controls, and blank windows, document writing,
named-window reuse and WindowProxy access are not emulated.
Artifact frames additionally allow downloads so ordinary library-owned controls can
export local PNG, SVG, or editable documents; interviews and session plugins do not
receive that download grant. Retained assets are served with explicit MIME types,
CORS headers, and `nosniff`. Both native content schemes are registered together
before Electron readiness; separate registrations overwrite fetch privileges.
Libraries may compile WebAssembly under `wasm-unsafe-eval`, without granting
JavaScript eval. Native exporters can embed complete local fonts when an optional
optimizer requires forbidden JavaScript eval.
CSP blocks external fetch/XHR/WebSocket (including library network helpers), while
allowing local retained widget-resource loads and passive HTTPS/data image and media
loads. Specialist instructions
require self-contained output with local data and no remote resources. The
sandbox exposes no direct Node, Electron, filesystem or parent-DOM access; trusted
host functionality goes through the validated Cake-command bridge.
Runtime errors and frame height cross a token-tagged `postMessage` channel;
artifact-capable widgets additionally receive the token-bound scoped state,
semantic-tool and trusted backend Cake-command bridges. The opaque frame still has
no direct Node/Electron or parent-DOM access. Display/request widgets do not receive
those artifact host bridges.

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
result does not itself expose native image blocks and explicitly warns when pixels were not forwarded. Alternatively resolve the exact
reference and read `preview.png` with an image-capable file tool. Historical snapshots
without a retained capture report an explicit unavailable error; there is no new render,
private-transcript recovery, latest-revision substitution, or mutation of old snapshots.

Retained previews are labeled **Initial state—not current interactive view** in the UI and
image-operation metadata (`retained-initial-state`, with exact reference). They remain immutable.
The live widget has no current-view attachment action. Ordinary screenshot and attachment workflows
remain available separately; retained previews never track widget-local interactions.

Saved lineage state is advisory, not an atomic snapshot of arbitrary widget-local state.
A matching revision alone can still mean initial A versus live C. Before implementing an approved
interactive view, request a screenshot and confirm its artifact revision and selected state.
Source or image descriptions alone are never visual verification. Read source selectively for
behavior, without importing the generation conversation. Compare the implementation's real
screenshot against the approved view and verify relevant interactions.

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

## Selected-prototype source handoff

New prototype-ui widgets encode `export default <strict JSON>;` with schema
`cake.prototype-source/v1`: one chooser, exactly five stable option modules and
bounded shared modules. Each module contains an ID, TSX source and exact static
import/re-export dependency manifest. Cake assembles this manifest from the side chat's
widget files and derives each dependency list from the module's imports. The compiler and source reader validate the
same structure and AST imports; missing modules, duplicate IDs, cycles, dynamic
imports and cross-option dependencies fail. The chooser compiles all five options
as one interactive widget; extraction does not guess component boundaries.

`artifacts.selection.capture` requires a linked exact current revision and observed
nonzero state version. It captures only `cake.selected-design/v1` metadata: exact
reference/digest, stable option ID, saved choice schema/value and version. This
bounded JSON can be forwarded as ordinary message data, or via Workboard within a
family; no new attachment type, automatic source expansion or transcript authority
is introduced. The receiving session explicitly uses `artifacts.link`, then
`artifacts.source` with the captured reference. Discovery returns only the chosen
option and transitive shared module IDs/dependencies. An explicit module ID reads
one character-paged source (maximum 48000 characters). External package imports
are listed, not copied. Chooser/other-option modules cannot be requested.

The receiver retains the existing effective-link permission check. References
are not access grants or authenticated claims about pixels. Saved state is mutable
and advisory: stale versions/revisions, digest/evidence mismatches, unknown choices,
missing manifests/source/dependencies and unauthorized reads fail explicitly.
Recapture after drift; never silently return latest or all alternatives. Historical
widgets remain viewable but need an explicit revision adopting the manifest before
selected-source retrieval. Permanent chats expose link, inline presentation, saved-state read,
selection capture and selected-source retrieval for this workflow, not generation,
publication, state writes, preview or whole-widget source tools.

No screenshot or generation history is included in source handoffs. Source is not
visual verification; current-view pixels remain a separate optional user action.

## Live editable artifact state

The SDK, live host and isolated review host reject non-JSON saves rather than
silently normalizing them. In particular, own `undefined` properties survive
structured clone. Widgets normalize their selected persistent data before saving;
well-addressed malformed requests receive a correlated error identifying the bad
value instead of timing out as a disconnected host. Retained older browser outputs
still receive host-side validation; changing their source requires a new revision.

Each lineage has one current JSON state, independent of immutable source revisions
and Pi transcript history. It has only a compare-and-swap version, not document
history, snapshots, patches, or an event log. The repository atomically overwrites
current state in its private catalog envelope. State is shared across linked
sessions and open instances, including views of older source revisions; restoring
source does not restore old document data. Unrelated lineages remain isolated.

HTML artifacts use `globalThis.cakeArtifact`, the same token-bound scoped state bridge
used by the React SDK, without importing a package. It exposes `read()`,
`getSnapshot()`, `subscribe(listener)` (returns unsubscribe), and
`replace(jsonValue, expectedVersion)`. Read resolves `{version, value}`; snapshots
also contain `hydrated` and `error`. No arbitrary lineage ID or host operation is
accepted. Display widgets have no such capability. Example inside an inline script,
after `<button disabled>Loading</button><output aria-live="polite"></output>` exists:

```js
const api = globalThis.cakeArtifact;
const button = document.querySelector("button");
const notice = document.querySelector("output");
button.disabled = true;
function render() {
  const state = api.getSnapshot();
  button.disabled = !state.hydrated || !!state.error;
  if (state.hydrated) button.textContent = `Count ${state.version === 0 ? 0 : state.value.count}`;
}
api.subscribe(render);
api
  .read()
  .then(render)
  .catch((error) => {
    button.textContent = error.message;
  });
button.onclick = async () => {
  const state = api.getSnapshot();
  const count = state.version === 0 ? 0 : state.value.count;
  button.disabled = true;
  try {
    await api.replace({ count: count + 1 }, state.version);
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    // Conflicts refresh state; do not blindly retry.
    render();
  }
};
```

Persist only JSON, choose a
schema that handles saved null if supported, and capture the version with the edited
data rather than looking up a newer version at save time. Version 0 uses your seed;
saved null has a nonzero version. Subscribe for live changes from other instances.
Reloading/reopening source rehydrates the current lineage document; DOM/JS variables
are mount-local and are not saved automatically.

`@cake/artifact-sdk` exposes `useArtifactState(initialValue)` returning
`{ value, hydrated, version, save, error, reload }`, and a narrow read/replace API through
`useArtifact()`. The host authenticates messages by frame source and compilation
token and scopes access to the displayed lineage. Display widgets cannot acquire
persistence. Hooks wait for hydration; saves before hydration reject. Version 0
means no stored document and uses the hook seed, while explicitly saved `null`
has a nonzero version. Save callbacks retain the version of their rendered state;
a rejected CAS refreshes authoritative state before rejecting to the widget. The widget
owns serialization, debounce, explicit-save controls, and error handling. Current
state updates notify other open instances without reloading their browser output.
No save is promised for abrupt application termination before a pending debounce.

### Read-aloud

Artifact widgets and Session Plugins can read text aloud with the user's configured
speech output (Pocket TTS or ElevenLabs). HTML uses `globalThis.cakeSpeech`; React
uses `useSpeech()` from `@cake/artifact-sdk` or `@cake/plugin-sdk`. `speak(text, { from })`
accepts text of any length and settles when reading ends, is stopped (resolve) or fails
(reject with the provider's message, such as missing configuration). `pause()`,
`resume()` and `stop()` control it; `getSnapshot()`/`subscribe()` report
`{ status, chunk, chunks, start, end, error }`. The renderer host splits text into
sentence chunks of at most one provider request, synthesizes up to two chunks ahead,
and reports the audible chunk with its character offsets for highlighting. `from` restarts
at a chunk; there is no time seek. Pause suspends the reader's own audio clock, separate
from voice mode. One frame speaks at a time: another frame's `speak` or unmounting stops it.
Display and request widgets have no speech capability. No main-process or IPC surface
beyond the existing `speechOutput.synthesize` stream is involved.

Generic `artifacts.state.read`, `artifacts.state.replace`, and
`artifacts.state.update` operations inspect and modify the current JSON document.
Writes require the observed `expectedVersion`; update applies bounded JSON-pointer
set/remove operations. A conflict requires rereading and reapplying the intended
delta, never blindly overwriting newer manual edits. Data-only changes create no
source revision and invoke no generator/compiler/reviewer. A widget must apply
its own native layout/normalization when external JSON changes; for example an
editable canvas remeasures bound labels and persists normalized geometry without
regenerating its editor. Library-specific schemas, element identity, selection
context, exports, and surgical editing rules belong to the skill and widget,
not these tools. Repeated independent documents can use `widgets.instantiate`
with the same accepted implementation and separate initial state.

Source edits fork the existing private Pi artifact branch as a new side chat. Its
widget files start from the accepted source (a prototype manifest splits back into its
chooser, option and shared files) and its state from current live state; it reads skill
resources and edits files without touching the live document. Compilation and capture hydrate an isolated in-memory candidate.
Acceptance publishes source/browser/capture and changed state atomically; cancellation,
review failure, or a stale changed-state version publishes nothing. Unchanged state
is omitted from the publication transaction so unrelated live saves survive.

## Verification

Deterministic tests cover protocol versions, input limits, unsafe media,
response schemas, widget generation and cancellation before persistence,
historical architecture fallback migration and fork-pointer verification,
content addressing, revisions, hydration, Markdown export, driver correlation,
table interaction and the empty-sandbox/CSP boundary. The artifact Electron smoke
covers table sorting, HTML isolation, Mermaid rendering, and application-restart
hydration. Interview response, cancellation, remount, and cleanup coverage is
separate.
