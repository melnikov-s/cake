# S4 artifact protocol and ownership

Cake's first rich-output contract is `cake.artifact/v1`. The shared Zod schemas
live in `src/ipc/artifact-contract.ts`; the same contract validates Pi tool
input, main-process persistence, preload IPC, renderer Models, interaction
responses, and session pointers.

Unknown protocol versions and kinds normalize to a v1 Markdown artifact using
their required fallback. Malformed artifacts that claim a known v1 kind remain
hard failures, so fallback cannot bypass v1 validation or media restrictions.

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
  remain in `WindowStore` and `PiWorkspaceDriver`.
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

The built-in Pi extension registers:

- `ui_present`, which persists a present-mode artifact, appends its Pi pointer,
  and immediately returns a concise textual result;
- `ui_request`, which persists a request-mode form, appends its pointer, and
  waits for one schema-validated response or cancellation.

Only forms may use request mode in v1. A pending request has a unique request
ID and exactly one terminal settlement. User cancellation, Pi abort signals,
session replacement, workspace-driver disposal, and loss of the last workspace
window all settle it as cancelled. Late or mismatched responses are ignored.

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

## Verification

Deterministic tests cover protocol versions, input limits, unsafe media,
response schemas, content addressing, revisions, hydration, Markdown export,
driver correlation, duplicate/late responses, session replacement, table and
form interaction, and the empty-sandbox/CSP boundary. The Electron smoke covers
table sorting, a structured form round trip acknowledged by revision update,
HTML isolation, Mermaid rendering, and application-restart hydration.
