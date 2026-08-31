# Cake storage ownership

Cake stores Cake-owned facts in versioned documents through focused Effect
Services. Pi separately owns Pi Session files and credentials. Storage format,
location, and migration never change authority.

## Storage roots

Cake resolves its persistent home once. The default is `~/.cake`; `CAKE_HOME`
replaces that root for tests and alternate installations.

```text
~/.cake/
├── plugins/
├── recovery/
├── state/
├── pi/
│   ├── auth.json
│   ├── models.json
│   ├── models-cache.json
│   ├── settings.json
│   ├── sessions/
│   ├── resolved-sessions/
│   ├── review-sessions/
│   └── global-chat/
│       ├── sessions/
│       └── resolved-sessions/
```

Electron-platform documents and repositories may remain under
`app.getPath("userData")`, with `CAKE_ELECTRON_USER_DATA` as the test override.
`CakePaths` resolves these locations in main; renderer code never constructs
storage paths.

## Focused storage Services

Cake does not expose a generic `get(key): unknown` persistence service. It uses
focused Services such as:

```text
ApplicationStorage
WindowStateStorage
WorktreeStorage
ReviewStorage
ArtifactStorage
PluginStorage
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

Every standalone stored document has an explicit envelope:

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
high write concurrency, or scale that files cannot support.

## Renderer snapshots

r-state-tree snapshots serialize renderer-owned application state:

```text
explicit snapshot fields
→ r-state-tree snapshot capture/change observation
→ RendererClient.windowState
→ WindowStateStorage
→ versioned file
```

Typical persisted values include:

- selected Project and Cake Session references;
- sidebar, panel, and workbench state;
- staged unsent chat and explicit drafts;
- composer drafts and selected settings;
- loaded-session references where needed for restoration.

Do not persist:

- Pi transcript or message projections;
- Pi resource catalogs that can be reloaded;
- live operation, loading, or streaming state;
- Fibers, Scopes, Streams, subscriptions, timers, or handles;
- terminal output or PTY resources.

Hydration order is mandatory:

1. main reads, migrates, and validates the stored document;
2. the renderer creates and mounts the r-state-tree root with the complete
   snapshot, or atomically applies it before ordinary workflow effects begin;
3. the owner selects an explicit fallback if application fails;
4. Store effects and projection attachment activate after hydration;
5. a scoped, debounced snapshot observer persists future commits through
   `RendererClient`.

Defaults must never overwrite a saved document before hydration. Projection
Models reconstructed from authoritative Streams are excluded from the window
snapshot.

## Pi-owned storage

Pi Session history remains authoritative in Pi JSONL. Every Pi Service call
receives its roots and Working Directory explicitly. Cake accesses transcripts
only through Pi APIs; it does not tail, parse as an application model, or write
Pi JSONL directly.

Project Sessions create, continue, inspect, and fork beneath Cake's configured
Pi session roots. Resolving a settled session disposes its live runtime and
atomically moves the transcript to the matching Cake-managed archive root;
restoring or messaging it moves it back before Pi opens it. Archive location is
Cake's resolution fact, while Pi remains the transcript-format and session
engine authority.

Discussion Sessions and Cake Chat Sessions use their narrower Pi roots. Cake
stores review/message anchors and sidecar references, while sidecar replies
remain only in their Pi Session files.

Window state stores stable Cake/Pi identifiers and Working Directories, never
absolute transcript filenames. Restart resolution asks Pi beneath the current
configured root.

Pi owns provider credentials and Pi resource settings. Cake storage may hold a
Model Preset or Utility Model Preference referencing provider/model IDs, but it
never stores provider secrets or utility-completion transcripts.

## Artifact, review, plugin, and Custom Renderer storage

Artifacts use bounded, versioned metadata and content-addressed payloads.
Reviews store Cake-owned anchors and workflow metadata. Plugin storage is
namespaced by stable plugin ID. If the separately scoped future Custom Renderer
is implemented, its storage records immutable base revisions, user patches,
semantic intent, diagnostics, activation history, and namespaced renderer
snapshot state. That storage is not part of the Effect migration.

Broken plugin or future Custom Renderer source, data, and diagnostics are preserved
for repair. Recovery may disable or roll back executable code without deleting
its evidence.
