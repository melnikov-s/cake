# S4 artifact protocol and ownership

Cake's durable rich-output contract is `cake.artifact/v1`. The blocking input
contract is `cake.request/v1`. Their shared Zod schemas validate Pi tool input,
main-process persistence, preload IPC, renderer Models, interaction responses,
and session pointers.

Unknown protocol versions, unknown kinds, and malformed payloads are hard
failures. Cake is greenfield and does not reinterpret unsupported protocols as
Markdown or carry compatibility behavior for superseded contracts.

## Authority and durability

- Cake owns artifact payloads and metadata. Pi remains the transcript and
  session-tree authority.
- Electron main stores payloads under `app.getPath("userData")/artifacts` as
  SHA-256-addressed JSON blobs. Atomic per-session metadata files point to the
  blobs. Artifact IDs are stable within a session and revisions must begin at
  one and advance exactly one step.
- Pi receives a `cake.artifact/v1` custom entry containing the artifact ID,
  session ID, revision, kind, digest, and Markdown fallback. It never receives
  a second Cake-owned transcript.
- Renderer `Artifact` instances are disposable projections of validated
  repository records. Pending response ownership, cancellation, and routing
  remain in a focused renderer artifact workflow Store and `PiWorkspaceDriver`.
- Cake indexes the persisted Pi session reference in window state and records
  artifact session aliases when Pi materializes a new persistent session ID.
  Hydration combines validated Pi pointers with that Cake index, so artifacts
  survive both renderer reload and application restart without guessing from
  transcript content.

The maximum serialized tool input and response size is 1 MiB. Larger payloads
are rejected before display. This is the S4 answer to Q4: the durable location
is the Electron user-data artifact repository, and the v1 inline protocol cap
is 1,048,576 UTF-8 bytes.

## Tools and interaction lifecycle

The built-in `cake` gateway exposes `requests.open`, which accepts one
`cake.request/v1`, persists it at the tool-call position, and waits for one
schema-validated response or cancellation. Its `view` is either a Cake-rendered
form definition or a sandboxed HTML/React widget. The form view is preferred for
ordinary fields; custom code is for genuinely visual interactions.

Only internal request artifacts may use request mode. A pending request has a
unique request ID and exactly one terminal settlement. Values are checked in the
renderer before transport and again at the Pi boundary. Invalid values keep the
request open. User cancellation, Pi abort signals, session replacement,
workspace-driver disposal, and loss of the last workspace window all settle it
as cancelled. Late or mismatched responses are ignored.

The `/cake-artifacts` built-in diagnostic command exercises the same repository
and response route without provider credentials. It is used by the deterministic
Electron acceptance test.

## Trusted built-ins and untrusted HTML

The trusted renderer includes Markdown, sortable/filterable/selectable/exportable
tables, Mermaid diagrams, schema-defined forms, media, diffs, and HTML frames.
Every surface retains its Markdown fallback, and session export concatenates
those fallbacks into a readable Markdown document.

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

Cake starts a separate hidden, persisted Pi session with tools, extensions,
skills, context files, and project trust disabled. That agent returns one React
component from the untrusted brief. Electron main compile-checks it before
persistence. A failed build is passed once through the same isolated repair
pipeline with the compiler diagnostic, then checked again. Cake persists the
validated source as a `widget` artifact and appends only the ordinary artifact
pointer and fallback to Pi. The tool result contains the artifact ID, allowing
the renderer to place the widget at the tool-call position.

React source is bundled as TSX, must default-export one component, and may
import React plus Cake's approved, bundled D3 modules (`d3` or `d3-*`) only.
Prefer submodule imports for smaller bundles; `import * as d3 from "d3"` is
supported for convenience. D3's network-oriented helpers remain unable to
reach the network because the widget CSP blocks network access. The widget runs
in an `allow-scripts` iframe without same-origin privilege, with a CSP that
blocks network access, forms, navigation, and Cake, Node, Electron, and
filesystem access. Runtime errors and frame height cross a token-tagged
`postMessage` channel; no general bridge is exposed.

Each widget shows Source and Repair controls. Repair starts another isolated Pi
session with the stored source, stored brief, and diagnostic as untrusted data.
Cake compiles the returned source through the same boundary before rendering
it. A later user-requested revision can use this same private source-plus-delta
pipeline without loading the implementation into the primary context.

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
response schemas, content addressing, revisions, hydration, Markdown export,
driver correlation, duplicate/late responses, session replacement, table and
form interaction, and the empty-sandbox/CSP boundary. The Electron smoke covers
table sorting, a structured form round trip acknowledged by revision update,
HTML isolation, Mermaid rendering, and application-restart hydration.
