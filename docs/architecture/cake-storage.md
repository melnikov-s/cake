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
│   ├── resolved-project-metadata/
│   │   └── resolution.json
│   ├── artifacts/
│   └── reviews/
├── pi/
│   ├── review-sessions/
│   ├── widget-sessions/
│   ├── subagent-sessions/
│   └── global-chat/
│       └── coordinator.sqlite     # Pi Durable; permanent Cake Chat
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
| Result reporting — response journal and delivery worker                  | Recipient transcript receipt, not queue insertion, confirms handoff                                                                     | Durable outbox intents retry using correlation and receipt checks; interrupted Project work is reported, not rerun.                                                                                                                                                   |
| Scheduled Project messages — scheduled delivery workflow/storage         | The durable intent remains cancellable until delivery; normal Pi admission is the handoff                                               | Pending schedules persist; after handoff, Project runtime queues retain their ordinary lifetime. This is not a general idempotent command bus.                                                                                                                        |
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

Discussion and other regular-Pi sidecar sessions use their narrower Pi roots.
Cake stores review/message anchors and sidecar references, while sidecar replies
remain only in their Pi Session files.

Window state stores stable Cake/Pi identifiers and Working Directories, never
absolute transcript filenames. Restart resolution asks Pi beneath the current
configured root.

Pi owns provider credentials and Pi resource settings. Cake storage may hold a
Model Preset or Utility Model Preference referencing provider/model IDs, but it
never stores provider secrets or utility-completion transcripts.

### Permanent Cake Chat

The coordinator's sole transcript authority is Pi Durable's supplied SQLite
adapter at `<CAKE_HOME>/pi/global-chat/coordinator.sqlite`. It owns originals,
inbox, execution checkpoints, and recovery. Cake does not implement a second SQL
store, mirror JSONL, or archive the coordinator through Project Session storage.
Its summary nodes and memory checkpoints live through the same SDK storage API.
Application storage separately owns memory preferences, dedicated instructions,
and the Subagent default model setting (absent means inherit).
The permanent coordinator can read and update only its dedicated instructions with
`settings.cake-chat.get` and `settings.cake-chat.update`. Updates use the existing
application-state transaction, preserve other preferences, and require the exact
previous instructions to reject stale replacements. The user-facing setting remains
Settings → Application → Cake Chat → Cake Chat instructions. Saved changes apply to
the next Chat message without a reload; they are never summarized into memory.

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
