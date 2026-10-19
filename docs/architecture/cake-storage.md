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
For continuation:none, `notified` means the reporting inbox durably owns the compact handoff,
not that its content was communicated. Inbox admissions retain pending intent; explicit
`sessions.reports.acknowledge` receipts reference already-visible Pi assistant parts and
suppress further replay. Pending handoffs retain worker provenance independently of memory
summaries. Handling drops the temporary payload, retaining only IDs/disposition/evidence;
no second transcript is kept. See the quiet-worker contract in `session-family-contract.md`.
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
choices with Fast mode off. Version eight restores saved 128,000-byte memory budgets
to 40,000 without changing other preferences. Earlier settings did not distinguish a
copied default from an explicit 128,000-byte choice; both transition once. Other custom
budgets remain unchanged, and a new explicit 128,000-byte choice is retained in version
eight. Absent preferences use the 40,000-byte default.
The permanent coordinator can read and update only its dedicated instructions with
`settings.cake-chat.get` and `settings.cake-chat.update`. Updates use the existing
application-state transaction, preserve other preferences, and require the exact
previous instructions to reject stale replacements. The user-facing setting remains
Settings → Application → Cake Chat → Cake Chat instructions. Saved changes apply to
the next Chat message without a reload; they are never summarized into memory.
These application preferences remain shared by permanent chats, separate from per-project
guidance. Only global Cake Chat exposes the shared-instruction writer, so Project Chat
cannot mistake it for a project save.

Each registered Project separately owns `settings.projectChatInstructions`. The
Project settings dialog labels it **Project Chat instructions**, while the existing
`settings.customInstructions` remains **Project Session instructions** for coding
sessions only. Missing Project Chat guidance decodes to empty; existing user text
is neither moved, copied, nor deleted, and the storage envelope remains version seven.
The permanent chat rereads its registered project's guidance for each message.
Coding runtimes and global Cake Chat never include this per-project text.

`settings.project-chat.get/update` require an exact registered `projectPath`,
return that identity with the committed text, and use the same application-state
transaction and setting as the dialog. Updates require `expectedInstructions`;
stale reads and failed persistence never report success. A Project Chat can target
only its own registered root; global Cake Chat may explicitly target any registered
Project. Coding Project Sessions expose the same dedicated operations, bound to their
registered Project rather than their working-directory/worktree path. Their updates
recheck the existing selected-project authorization at execution time. Read-only
auxiliaries do not receive these controls. All callers use the same persisted setting,
conflict check, and committed readback; an unavailable operation must never silently
fall back to the shared writer. Coding sessions can also patch their own Project via
`project.settings.update`, whose field guidance distinguishes the two instruction scopes;
prefer the dedicated instruction operations for their read-before-write protection.

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

Permanent Chat retains its active prefix between warm turns. The existing conservative
policy may reset on unknown/uncertain cache status or inferred coldness only when the
complete memory index is already built; it never waits for summary providers just for cache
freshness. The effective input limit still requires preparation; restart alone is not expiry.
Regular Project Sessions do not acquire a
cache-expiry compaction trigger. The context-policy document stores request/completion
times, requested retention separately from resolved provider-payload policy, reported
reads/aggregate writes and available five-minute/one-hour creation counters. Missing
provider callbacks and legacy fields remain absent, not invented. Anthropic's rolling
partial-prefix estimates retain one-hour creation evidence across requests/restart;
unallocated mixed-TTL reads do not refresh either estimated clock. These estimates are
not whole-prefix hits or confirmed remote expiry/eviction. OpenAI retention options and
Bedrock cache points are retained separately, without borrowing Anthropic semantics.

SDK automatic threshold/background compaction remains disabled. At the root provider
boundary, an actual context-overflow error can trigger one blocking reset through the
same bounded memory path and one retry per admitted run input. The attempt marker is
committed before recovery, so restart does not rearm it. Originals remain authoritative;
current user input and tool call/results stay verbatim and ordered, without rerunning
tools. Repeated overflow or an irreducible current input fails visibly. Admission reserves
model output room (by default up to 16,384 tokens, capped by model output capacity), and
the request output cap uses that same reserve.
Side-chat requests retain their separate SDK behavior rather than mutating the root head.

#### OptMem whole-chat memory

The kernel reference is [VictorTaelin/OptMem](https://github.com/VictorTaelin/OptMem/tree/1fb164cf39028047781f72ac3bb1e5a691c1dcb0)
at revision `1fb164cf39028047781f72ac3bb1e5a691c1dcb0` (`memo` and README).
That standalone kernel records selected 280-byte notes, builds aligned binary ranges,
and computes an alpha-refit reading view. Cake uses the author's
[public chat-memory specification](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/3c190e06f34aba0c69f49042c526093269604935)
at revision `3c190e06f34aba0c69f49042c526093269604935` for its **whole-chat adaptation**:
512-byte leaf/pair summaries, a persisted byte-budget sawtooth view and concurrent
background compactions. This is not a claim that the standalone CLI has those policies,
nor evidence of a public implementation of the author's chat application.

Only dialogue from SDK originals enters the tree: user inputs (`pi.user`) and text
blocks from assistant outputs (`pi.assistant`). Tool calls/arguments, tool results,
assistant reasoning and error metadata are excluded. Mixed assistant entries contribute
only their nonblank text blocks; tool-only/blank assistant entries create no leaf or
merge jobs. Pi remains the authority for complete originals, including images, tool
traffic and reasoning. Live warm context retains tool traffic unchanged; compaction
replaces older dialogue with memory without carrying older tool traffic forward.
SDK entries remain the source/zoom units, not a second transcript. Zoom navigates
indexed dialogue ranges; excluded tool-only entries have no memory leaf. Findings
that appear only in tool output are not retained in memory unless reported in dialogue.
Every rendered memory line also carries runtime-derived `[originals=A..B]` metadata:
the inclusive SQLite entry IDs of its first and last dialogue originals. Parent bounds
follow the tree's outermost leaves; zoomed children expose narrower bounds and leaves
identify their exact original. Intervening tool-only entries are searchable within the
span even though they have no memory leaf. These are location spans, not claims that
every entry in them contributed dialogue; tool-only gaps outside a line's endpoints
require a neighboring/wider search. Bounds are derived by reading only the tree's two
boundary paths, not by summarizing provenance or scanning entire subtrees. They are
rendered outside stored summary text, counted in view byte budgets, and reconstructed
from existing immutable nodes on restart. No state/node version change or rebuild is
needed. Existing warm heads remain unchanged until the ordinary next memory handoff.
The runtime prompt separately carries the stable `cake://session/<id>` conversation
reference and recall guidance, outside compressed memory. `conversation_search` searches
or browses this conversation's SQLite originals through the SDK, including tool calls
and results; `conversation_read` pages exact original text or a JSON record with stored
arguments, results, details, diagnostics and timing. The tools are read-only and pinned
to the owning runtime's conversation/database; side-chat callers cannot use them.
Start searches with a relevant memory line's inclusive `fromEntryId=A` and
`throughEntryId=B`; broaden only when that span lacks the necessary evidence.
Search scans at most 1,000 entries per call and returns at most 20 excerpts. Continue
with `nextAfterEntryId` as `afterEntryId`, the same inclusive bounds, and unchanged filters; a partial
scan with no matches is not an exhaustive negative. Read offsets count UTF-16 characters;
record pages must be concatenated before JSON parsing. Image bytes and reasoning are
omitted, provenance and stored truncation diagnostics remain intact, and historical
receipts do not establish current domain state. Retrieval requires no additional
transcript/index, memory rebuild, or full-history injection into each turn.
Worker/report provenance and separately durable handling obligations remain distinct
from human-authored input.

The deliberately small default view grows to 40,000 UTF-8 bytes, then consolidates
toward 20,000; zoom supplies detail. Explicit user budgets can change this, and
model-window admission can lower it. The most-due built sibling pair wins, using age
from the pair's last message divided by its child size, oldest first on ties. The exact
view and ancestor references persist; restart alone does not refit it. A changed budget
is applied at the next index synchronization/preparation: an oversized view collapses
stored ancestors without provider calls when the index is complete. Pending parents
resume from committed progress on required preparation or idle maintenance; optional
cache-only preparation defers instead of waiting. Neither a settings migration nor
index fitting rewrites a warm active head. The smaller view reaches model input only
at the next normal cache-cold/unknown or limit/overflow handoff, under the unchanged
active-context policy (300,000 tokens by default). No memory-index version change,
reset, or rebuild is needed. Application settings migration runs when the updated
backend loads application storage; a renderer-only reload does not reload that owner.
A separate compaction reference view uses a 32,000/16,000-byte sawtooth and reconsolidates when the
chat view consolidates. It ends before a leaf, or at a merge's end, and stops at the first
unbuilt original. It never includes future text, raw unsummarized fragments or placeholders.

A persisted, bounded source window (up to 64 scanned entries) assigns chronological range
IDs. Ready queues permit up to eight independent requests; a leaf starts with fewer than
eight preceding unbuilt leaves, and parents start only after both children are committed.
The single persistence owner does not serialize HTTP requests. Each completed node and its
DAG checkpoint commit atomically; the built-prefix cursor/view advances in order. Version
three checkpoints discard earlier derived indexes (including pending jobs) and rebuild
from dialogue-only originals. Old immutable summaries remain stored but are no longer
indexed; original entries and the active head are not rewritten. Range IDs are reassigned
by the rebuilt index. A range in a retained pre-rebuild head cannot resolve to a
newer node: zoom/inspection rejects that stale handle until the next memory handoff;
original-history reads remain available. Subsequent reopen retries unfinished nodes,
not their already committed children.
The bounded working window limits live state; dependencies drain before admitting another
source window. Reads and zoom lazily retrieve immutable entries, not a lifetime node cache.

Sources/pairs within 512 bytes pass through unchanged. Oversized nodes use the shared
coordinator system prompt and tool definitions (tools are never executed by the compactor),
a 512-dash ruler and up to five total attempts. Saved active heads predating the shared
compaction section receive its data/provenance safeguards in the task until an ordinary
request updates the system prefix; maintenance never rewrites that retained head. Shortening feedback uses actual byte counts,
a UTF-8-safe cut marker, and real assistant/user turns in the same request conversation.
After five oversized responses the shortest complete response is retained, as specified;
it can exceed 512 bytes. The view measures actual sizes. Empty responses and transport
overflow fail explicitly, never publish a placeholder or truncate a stored answer. The
summarization-model setting still resolves through the existing provider/utility selection,
not a hard-coded provider.

Incremental maintenance is independent of Cake's deliberate warm-context retention.
Successful terminal assistant commits coalesce into one pending cutoff; idle maintenance
indexes through it without replacing the active head or cache evidence. Reopen resumes
persisted jobs. Error, aborted and tool-use responses do not independently rearm maintenance.
There is no expiry timer, polling worker, or automatic failed-call retry loop: a later
successful run, reopen or explicit foreground preparation offers another opportunity.

Memory catch-up and its utility completions have no wall-clock deadline or call-count
allowance. Ready-node concurrency bounds simultaneous requests, not total catch-up work.
Stop, foreground preemption and closure cancel outstanding calls and drain the commit owner;
even a callback that ignores cancellation cannot publish a late result. Storage relies on
SDK context cancellation, not a hard real-time guarantee for uninterruptible I/O. Successful
nodes remain durable when lifecycle cancellation pauses a large catch-up.

A replacement active head publishes only after the complete requested memory view persists.
Preparation failure retains the previous head and clears activity. Optional cache-only
preparation uses a ready-only index read: pending leaves/merges, unindexed dialogue (including
a migrated-index rebuild), or insufficient room for the handoff defer it to idle maintenance.
The foreground continues with its intact head within the input cap and output reserve,
without launching summary requests or publishing a partial reset. Limit/overflow resets and
cancellation are never bypassed. Required preparation
failures use non-provider error text so Durable cannot replay them through generic coordinator
retries. Genuine coordinator provider failures retain their normal retry policy. Diagnostics expose fixed reason labels,
application-call counts and elapsed time, never source bodies or raw summarizer diagnostics.
Five size attempts and eight concurrent requests preserve the specified algorithm but can
increase provider cost; concurrency is a latency improvement, not a request-count reduction.

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
