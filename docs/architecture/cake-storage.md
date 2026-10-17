# Cake storage ownership

Cake stores Cake-owned facts in versioned documents through focused Effect
Services. Regular Pi owns its session files and credentials; permanent Cake Chat
uses Pi Durable's SDK-owned SQLite storage. Storage format, location, and migration
never change authority. These engines intentionally have different persistence
and recovery contracts, not two stores for the same transcript.

## Storage roots

Cake resolves its persistent home once. The default is `~/.cake`; `CAKE_HOME`
replaces Cake-owned metadata and sidecar roots for tests and alternate installations.
Pi independently resolves its agent home through `getAgentDir()` (normally
`~/.pi/agent`, honoring `PI_CODING_AGENT_DIR`). Cake does not set that variable.
Primary Project Sessions use Pi's normal encoded-cwd session directory, or the
`PI_CODING_AGENT_SESSION_DIR` / startup `sessionDir` setting, with native cwd
filtering for shared custom directories. Tests must explicitly isolate both homes.

```text
~/.cake/
├── state/
│   ├── application.json
│   ├── scheduled-messages.json
│   ├── worktrees.json
│   ├── session-metadata/
│   ├── session-families.json
│   ├── recovery-intents/
│   ├── private-workers/
│   ├── session-coordination.json
│   ├── resolved-project-metadata/
│   │   └── resolution.json
│   ├── artifacts/
│   └── reviews/
├── pi/
│   ├── review-sessions/
│   ├── widget-sessions/
│   ├── subagent-sessions/
│   └── global-chat/
│       ├── coordinator.sqlite     # Pi Durable; permanent Cake Chat
│       └── scratch/               # Neutral working directory for Cake Chat read/bash
└── cache/
    └── artifact-projections/
```

This is an ownership-oriented root map, not an exhaustive file inventory. See
[Permanent Cake Chat](#permanent-cake-chat).

`cache/artifact-projections` contains disposable, read-only, digest-verified
exact-revision files derived from the authoritative artifact repository. Cache
files can be deleted or rematerialized at any time and never participate in
publication, lineage reachability, or garbage collection.

Cake-owned durable domain data and configuration—including registered Projects,
each Project's managed-worktree commands, and Project-scoped custom session workflow
columns and assignments—live beneath `state/` and follow `CAKE_HOME`.
Primary Pi transcripts and Pi configuration do not follow `CAKE_HOME`. Workflow status is independent from the Pi transcript and
Cake's resolution metadata. Electron's
`app.getPath("userData")`, with `CAKE_ELECTRON_USER_DATA` as its test override,
contains only window/renderer presentation state and machine-local Electron or
embedded-editor data. `CakePaths` resolves durable Cake locations and disposable
cache roots in main;
renderer code never constructs storage paths.

## Pi configuration

Cake never copies or merges Pi credentials, models, settings, packages, or
resource directories. Extension switches in **Execution & resources → Automatic
extensions** use native global Pi `+`/`-` overrides and package extension
filters. They discover resources without installing packages or executing
extensions, affect terminal Pi too, and reload idle Cake runtimes (active
runtimes reload after their turn).

## Focused storage Services

Cake does not expose a generic `get(key): unknown` persistence service. It uses
focused Services such as:

```text
ApplicationStorage
WindowStateStorage
WorktreeStorage
ReviewStorage
ArtifactStorage
SessionArchiveStorage
```

Each Service owns:

- the data it is permitted to store;
- current Effect Schemas;
- version envelope and sequential migrations;
- file or repository layout;
- atomic-write and concurrency behavior;
- typed read, migration, and write failures.

They may share internal `FileSystem`, path, JSON, content-addressing, locking,
and atomic-write helpers. Domain operations use focused storage Services rather
than those helpers.

## Versioning and migration

Every standalone Cake-owned stored document has an explicit envelope. This does
not redefine Pi's JSONL or the Durable SDK's SQLite format:

```ts
interface StoredDocument {
  readonly version: number;
  readonly data: unknown;
}
```

Loading is:

```text
read file
→ parse envelope
→ migrate one version at a time
→ decode the current Effect Schema
→ return the current typed value
```

Saving is:

```text
current typed value
→ encode through Effect Schema
→ add current version
→ write a temporary file
→ atomically rename
```

A storage Service owns migration policy between stored versions. Domain code
and renderer Stores receive only the current type. Unknown future versions and
unmigratable documents produce typed failures and use the owning feature's
explicit recovery policy; they are never silently reinterpreted.

Versioned files are the default. Introduce a database only when a concrete
capability needs cross-record queries, multi-entity transactions, indexing,
high write concurrency, or scale that files cannot support. Using Pi Durable's
supplied SQLite adapter for Cake Chat does not change this Cake-owned storage default.

## Workflow recovery boundaries

One backend process owns Cake's storage and live coordinators. Desktop IPC and
network endpoints may share that acquired backend; separate Electron and Node
backends must not concurrently use the same data directory. This is the
[documented deployment assumption](../development/headless-backend.md#security-and-data-isolation),
not a claim that all storage supplies cross-process locking. Pi Durable explicitly
provides no database ownership lock across backend processes.

Atomic file replacement protects one document. It does not atomically combine
Cake metadata, a Git checkout, and a Pi transcript. A database transaction over
Cake records would not make those external systems part of the same transaction
either. Domain workflows own semantic completion and recovery; scoped capabilities
own live operation state, and storage Services own durable records.

The following summarizes existing contracts rather than adding a generic recovery
framework or an exactly-once guarantee:

| Workflow and owner                                                       | Acceptance or commit boundary                                                                                                           | Recovery and retry boundary                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Family child creation — `sessionFamilies`                                | Child identity and request correlation persist before the initial Pi prompt; creation completes at turn acceptance, not task completion | The same request returns the child identity; a failed launch retains a materialized child, while a reservation without a transcript is removed. See [family membership](./session-family-contract.md#membership-invariants).                                          |
| Worktree landing — `worktreeLandings` and its process-scoped coordinator | Accepted work owns a repository queue slot independently of renderer lifetime                                                           | Queue position/progress are process-local; persisted conflict/squash-message pauses can be adopted, and merge-and-resolve intent remains durable until completion. See [worktree ownership](./effect-architecture.md#filesystem-git-worktrees-vs-code-and-terminals). |
| Result reporting — response journal and delivery worker                  | Recipient transcript receipt, not queue insertion, confirms handoff                                                                     | Durable outbox intents retry with stable message identities and Pi consumption receipts. Active Project work is reconciled before interruption notices; digest receipts prevent reattaching an already-admitted update.                                               |
| Scheduled Project messages — scheduled delivery workflow/storage         | The durable intent remains cancellable until delivery; normal Pi admission is the handoff                                               | Pending schedules persist; after handoff, primary-session admission recovery retains unfinished input intents. This is not a general idempotent command bus.                                                                                                          |
| Permanent Cake Chat — Pi Durable                                         | SDK-owned admission, inbox, tasks, and checkpoints                                                                                      | Process-crash recovery follows the SDK contract; replay-unsafe Cake mutations require inspecting live state rather than blind repetition. See [Durable ownership](#permanent-cake-chat).                                                                              |

Surviving a client disconnect is not the same as surviving a backend restart.
A lost acceptance receipt is uncertainty, not proof that an operation failed;
network reconnection restores observations without automatically replaying mutations.
The focused contracts own the detailed recovery policies and limitations.

## Renderer snapshots

r-state-tree snapshots serialize renderer-owned application state:

```text
explicit snapshot fields
→ r-state-tree snapshot capture/change observation
→ Client.windowState
→ WindowStateStorage
→ versioned file
```

Typical persisted values include:

- selected Project and Cake Session references;
- sidebar, panel, and workbench state;
- staged unsent chat;
- composer drafts and selected settings;
- loaded-session references where needed for restoration.

Explicitly saved Draft records are shared backend data, distinct from client-owned
[unsent composer input](./README.md#saved-drafts-and-unsent-input). They are not
window snapshots; this distinction does not prescribe a new storage migration.

Do not persist:

- Pi transcript or message projections;
- Pi resource catalogs that can be reloaded;
- live operation, loading, or streaming state;
- Fibers, Scopes, Streams, subscriptions, timers, or handles;
- terminal output or PTY resources.

Hydration order is mandatory:

1. main reads and validates the stored document. Window state carries no
   migrations: a document from any other version fails to load and the renderer
   starts from the fallback below;
2. renderer bootstrap selects an explicit fallback if loading or snapshot
   validation fails;
3. the renderer mounts the r-state-tree Root Store once with the complete
   snapshot;
4. Store effects activate only after that one-time hydration;
5. bootstrap attaches the external Model observer and a scoped, debounced
   `onSnapshot` observer that persists future Store commits through
   `Client`.

Window persistence is not a Store and never applies a storage value to an
already-mounted Store. Storage-to-Store flow occurs exactly once at mount;
afterward the flow is only Store snapshots to storage.

Defaults must never overwrite a saved document before hydration. Projection
Models reconstructed from authoritative Streams are excluded from the window
snapshot.

## Pi-owned storage

### Regular Pi sessions

Regular-Pi Session history remains authoritative in Pi JSONL. Its Service calls
receive the applicable roots and Working Directory explicitly. Cake accesses
transcripts only through Pi APIs; it does not tail, parse as an application model,
or write Pi JSONL directly.

Project Sessions create, continue, inspect, and fork beneath Cake's configured
Pi session roots. Resolving a settled session disposes its live runtime and
atomically updates Cake-owned resolution metadata. Restoring or messaging it
clears that metadata before Pi opens it. Neither operation moves or modifies
the Pi transcript. Pi remains the transcript-format and session engine authority.

`state/resolved-project-metadata/resolution.json` is a versioned index of resolved
IDs keyed by their normal session directory. The permanent Durable coordinator
has no resolve/archive lifecycle.
Backend updates are serialized and atomically replace the metadata document.
Catalogs read the IDs once per listing and exclude resolved sessions before
opening Pi transcripts to derive titles; no LSM, transcript scan, or second
transcript database is needed. Project routing records retain the original
Project, Working Directory, and worktree name, but are not a second resolution
authority.

Former Project Session archive roots are migration input only. Storage records each archived
session as resolved before moving its original file back to the normal root;
retries preserve status and reject destination collisions instead of overwriting
files. Project archive migration v2 also uses retained routing records for
retired worktrees. No new resolved transcript files are created in archive roots.

Session Family identity, parent membership, direct-child creation order, fixed
Project and Working Directory bindings, and creation correlation are Cake-owned
and stored in `state/session-families.json`. The document never stores messages,
assignments, transcript history, or a competing resolved-state list.

Scheduled Project Session messages are Cake-owned delivery intents stored in
`state/scheduled-messages.json`. They remain visible and cancellable until their
deadline. Once Cake submits one through the normal Project Session prompt or
follow-up operation, it removes the intent and Pi owns the resulting user
message and turn.

### Primary-session restart recovery

`state/recovery-intents/<sha256-of-session-id>.json` retains accepted unfinished Project
Session, private worker and permanent chat inputs, their stable identities, and target bindings.
Admission commits this intent before starting Pi. Each versioned file belongs to one session;
reads and updates do not parse or rewrite other sessions' journals. It retains only unfinished
input envelopes, never a second transcript; settlement removes payloads and keeps the visible
terminal outcome and required delivery receipts. Permanent session deletion and explicit worker
close/expiry remove their recovery documents. Ordinary runtime release does not.
Blocked recovery retains its diagnostic and obligations rather than displaying a fake running status.
`state/session-coordination.json` separately retains message/thread correlation metadata,
closed state and outcomes, with no message bodies.

Backend startup reacquires journaled active sessions, including background sessions without
an open renderer pane. It does not start idle chats. Regular Pi's own custom entries identify
consumed inputs. Saved completed responses settle the original obligations without a new
model request; unconsumed ordinary inputs are restored once. Reconciliation stops at the
next run's input, while steering inputs consumed before the same answer share that answer. Interrupted generation or saved
tool-result boundaries get a contextual continuation, not a replay of the original prompt.
An unresolved tool call or ambiguous command handoff requires review, because its external
side effect may already have occurred. Deliberately stopped queues are restored paused and
wait for the next user input. Queue edits update the recovery intent before acknowledging.

Cross-session inputs use the message ID as the admission ID. An already consumed or pending
identity is not delivered again; permanent chats use Durable's idempotent request IDs.
Automatic reports use a separate deterministic message ID, never the worker's originating
input ID, so recipient settlement cannot overwrite the worker's obligation. Queue withdrawal
matches the recipient admission ID recorded by the delivery journal.
Digest status updates remain next-user-input-only, and the admitted recovery record retains
receipt IDs to reconcile a crash between user admission and outbox removal. One backend
serializes digest preparation through admission, not through the model response.

These guarantees apply to new admissions under this implementation. Old process-local queues
cannot be reconstructed after they have already been lost. Queued extension commands,
workflow-script execution and native subprocess lifetimes retain their
separate recovery limitations; this journal does not turn them into replay-safe operations.

### Private-worker restart recovery

`state/private-workers/<sha256-of-handle-id>.json` stores stable worker/parent identities and locations, model
and tool policy, exact forwarded attachment metadata and message references, unfinished
input envelopes, and completion-delivery IDs/dispositions. It stores no transcript parts
or tool outputs. Detailed worker history remains in Pi's subagent-session files, including
Cake Chat investigations previously held only in memory. Attachment grants remain in the
input vault; startup rebuilds each worker's exact message-reference allowlist without reading
source bodies or widening access.

Startup restores handle metadata before resuming parent inputs and releases worker continuations
after parent recovery admission. Terminal handles whose reports are already acknowledged acquire
neither parent nor worker Pi runtimes until the handle is used or its parent is observed. Shutdown
never turns these workers into aborted results. Completed replies are projected from Pi without
another model call. A report queued in a busy Project Session is not acknowledged until Pi has
appended its custom message; shutdown before that receipt leaves the worker's durable disposition
pending for retry. Stable completion IDs suppress retries after consumption. Worker notification
policy has one in-memory owner and is persisted with the current completion state. Missing transcripts or an
unfinished tool produce a visible worker failure/review requirement rather than a replay.
Explicit close and idle expiry remove the durable handle; they do not erase Pi history.
Workflow script workers retain their separately defined supervisor recovery policy.

Startup checks all restart-recovery documents before any automatic continuation or orphan-abort
reconciliation. Unreadable or unsupported metadata pauses automatic recovery without preventing
the backend from opening or replacing the evidence with an empty catalog. Errors name the file
and required repair. Saved conversations remain readable; malformed per-session journal metadata
appears as a repair notice. Affected coordination and admissions fail rather than claiming durable
acceptance, and unrestored worker handles report that recovery is paused. Repair the named file and restart to
retry automatic recovery. Pi transcript files are never rewritten to repair Cake metadata.

Discussion and other regular-Pi sidecar sessions use their narrower Pi roots.
Cake stores review/message anchors and sidecar references, while sidecar replies
remain only in their Pi Session files. Cake Chat side chats are Discussion
Sessions whose parent is the permanent Cake Chat; their records use the same
storage, keyed by Cake Chat's fixed identity and location. A side chat's
transcript is normally a Pi Durable fork inside Cake Chat's own
`coordinator.sqlite` (see below): the record stores only the fork's session ID
(`<Cake Chat ID>:side-chat:<conversation ID>`) and no transcript file. When
Cake Chat cannot fork at the anchored message, the side chat falls back to a
regular-Pi sidecar whose derived branch context (Cake Chat text through the
anchored message) is written once when the side chat starts and is never
regenerated, so later Cake Chat messages stay out of it.

Window state stores stable Cake/Pi identifiers and Working Directories, never
absolute transcript filenames. Restart resolution asks Pi beneath the current
configured root.

Pi owns provider credentials and Pi resource settings. Cake storage may hold a
Model Preset or Utility Model Preference referencing provider/model IDs, but it
never stores provider secrets or utility-completion transcripts.

### Permanent Cake Chat

The coordinator's sole transcript authority is Pi Durable's supplied SQLite
adapter at `<CAKE_HOME>/pi/global-chat/coordinator.sqlite`. Project Chats use the same
adapter at `<CAKE_HOME>/pi/project-chats/<sha256-of-registered-path>/coordinator.sqlite`.
Each database has its own root, memory tree, inbox, request identity and native forks.
Catalog discovery does not open unstarted project databases. It owns originals,
inbox, execution checkpoints, and recovery. Cake does not implement a second SQL
store, mirror JSONL, or archive the coordinator through Project Session storage.
Its direct `read`/`bash` tools start in the disposable sibling `scratch/`
directory, never a project root.
Its summary nodes and memory checkpoints live through the same SDK storage API.
The Cake Chat and Project Chat context browser reads the committed active head,
then lazily reads paired summary nodes and their original entries through that API.
Originals are depth 0; single-original summaries are depth 1, and each balanced
merge adds one summary layer (1 + log2 of the original count). These are tree
layers, not model-call counts. The browser is not shown in regular Project Sessions.
It does not synchronize the memory index, recompress, invoke the model's zoom tool,
or change the head. It is an ephemeral renderer view: closing discards its
contents, and retained history never becomes model input.
Included instruction bytes are projected from the assembled prompt, not reread
from disk. This assembled-context view is distinct from outbound request capture,
which remains the authority for provider-transformed request bodies.
Application storage separately owns memory preferences, dedicated instructions,
and two model choices that share one shape and Settings control (Inherit, Default
preset, Utility, a preset, or a specific model): the Summarization model (absent
means the utility model) and the Subagent default model (absent means Inherit).
Version seven converted older bare summarization models into specific-model
choices with Fast mode off.
The permanent coordinator can read and update only its dedicated instructions with
`settings.cake-chat.get` and `settings.cake-chat.update`. Updates use the existing
application-state transaction, preserve other preferences, and require the exact
previous instructions to reject stale replacements. The user-facing setting remains
Settings → Application → Cake Chat → Cake Chat instructions. Saved changes apply to
the next Chat message without a reload; they are never summarized into memory.

Side chats fork the coordinator conversation with Durable `fork()` after the
completed reply that closes the anchored exchange. The fork inherits Cake Chat's
exact model context and agent (prompt, model and tools) as of that entry, runs on
the coordinator's own Harness (one process owns the database), and survives
restart with it. Forks never write to the root conversation: the coordinator's
run-boundary memory reset, memory index, message count and snapshots consider
only root changes, and its `cake` tool refuses calls from a fork. Provider
requests from a fork carry Cake Chat's provider session identity, so their first
request reads Cake Chat's prompt cache. Durable treats a head marker as dropping
the system prompt and would re-send a complete baseline system message after it.
Cake Chat's run resets already carry the system message, so each reset is followed
by an empty `pi.system` marker in the same commit: tool rounds and later runs extend
the cached prefix, and Durable patches the prompt only when it really changes. A
fork whose branch point predates that marker gets one in its creating commit, so
its first request repeats Cake Chat's prefix exactly. That relies on Durable 1.1.0 prompt planning, which
is experimental.

The Pi Durable SDK supplies process-crash recovery, not a newest-commit power-loss
guarantee. Replay-unsafe Cake mutations require inspecting live state rather than
blind repetition.

## Artifact and review storage

Artifacts use one global, atomically replaced, versioned catalog manifest plus
SHA-256-addressed JSON blobs. The catalog records global lineages, immutable
full-snapshot revision indexes, and explicit links to either sessions or Session
Families. A link either follows latest or pins an exact revision. Links never copy
a payload. Publishing uses `expectedLatestRevision` compare-and-swap while one
process-wide storage lock serializes catalog mutations; stale writers receive a
typed conflict. Blob creation precedes the atomic catalog replacement, so an
interrupted publish can leave only an unreferenced blob, never a live revision
without payload.

The artifact catalog is storage-authoritative and validates every digest and
revision identity on read. Restoring historical content later publishes it as a
new `N+1` full snapshot and records the source revision in metadata; it never
rewinds or mutates history. Blocking request records remain outside this catalog.
The storage migration scans the former session-indexed metadata, fork/family
provenance, and immutable blobs once. It reconstructs complete revision chains,
converts owning associations to follow-latest links and inherited associations
to pinned links, excludes request records, and then writes the current catalog
envelope. When unrelated legacy chains reused the same artifact ID, migration
assigns a collision-safe global lineage ID and rewrites that chain's blobs so
their embedded snapshot IDs and content digests match the new identity. Unknown
versions, corrupt blobs, revision gaps, divergent ancestry, and ambiguous links
fail with a typed storage error rather than silently dropping data.

Deleting a session or family removes its links without synchronously deleting
artifact history. After the transcript/family authority mutation commits, and
once at startup, best-effort garbage collection snapshots the catalog, asks Pi's
`SessionManager` APIs to enumerate durable artifact pointers across active and
resolved Project Session roots, and reads current Session Family membership. A
lineage is retained by a link to a surviving session, a link to a family with a
surviving member, or any durable exact pointer in a surviving Pi transcript. The
Artifact Library is only a projection and is not a retention root.

The storage mutation runs under the same process-wide semaphore as publish and
link operations and proceeds only if the catalog still matches the snapshot used
for reachability verification. Initial publish and link are one catalog mutation,
so collection cannot observe a newly created lineage between those steps. A Pi
scan failure, malformed pointer, session-ID collision, or concurrent catalog
change retains data. Collection atomically removes proven-unreachable lineage,
revision, and stale-link metadata, then deletes only blobs unused by every
retained revision. All historical revisions of a retained lineage remain.
Disposable projection caches are reconciled separately against surviving session
and retained-lineage identities; cache deletion never affects authoritative blobs.

Reviews store Cake-owned anchors and workflow metadata.
