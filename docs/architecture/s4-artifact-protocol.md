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
- Renderer `ArtifactModel` instances are disposable projections of validated
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

The built-in Pi extension registers `ui_request`, which accepts one
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

## Inline widgets and repair

Assistant messages may contain `cake-html` and `cake-react` fences. Cake keeps
the surrounding Markdown in the normal streaming transcript and replaces each
closed fence in place with a widget. Open fences show a receiving state and are
not compiled until they close.

Electron main compiles widgets through the bounded inline-widget contract.
HTML may contain CSS and browser JavaScript. React source is bundled as TSX,
must default-export one component, and may import React only. Both run in an
`allow-scripts` iframe without same-origin privilege, with a CSP that blocks
network access, forms, navigation, and Cake, Node, Electron, and filesystem
access. Runtime errors and frame height cross a token-tagged `postMessage`
channel; no general bridge is exposed.

Each widget shows Source and Repair controls. Repair starts a separate hidden,
persisted Pi session with tools, extensions, skills, context files, and project
trust disabled. The current source, nearby message context, and diagnostic are
untrusted input to a narrowly scoped repair prompt. Cake compiles the returned
source through the same boundary before rendering it.

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
