# Session navigation, catalogs, and drafts

## Selection and metadata

`AppShellStore` owns one mutually exclusive window selection: a Project Session,
Cake Chat, settings, or empty workbench. Project selection contains only Session
ID; Working Directory is derived routing context. All visible/active navigation
follows this selection.

`SidebarStore` owns navigation mode, Project focus, visibility, width, and temporary
IDE overrides. `SidebarSessionListStore` owns sorting, family expansion/flattening,
root pagination, selected-row pinning, active-turn lane stability, group expansion,
and catalog demand. Neither selection/list Store opens Sessions directly. `SessionMetadataStore` joins
labels/activity for sidebar, composer, and controls without making facts sidebar-owned.

The window-owned `NavigationStore` coordinates Session opening, links, scoped
history, pane focus/splits/closure, and surface transitions without duplicating
selection or layout state. The stateless typed application command registry
dispatches hotkeys to focused owners and evaluates availability against current
state at invocation time.

`ProjectCatalogStore` owns registered Projects and window-local ordering. Global
and per-Project status catalogs have unique names across the combined catalog.
Draft, active custom statuses, and Resolved are independent of transcript lifecycle.
Main normalizes names and enforces transitions; `GlobalStatusSettingsStore`,
`ProjectSettingsStore`, and `SessionManagementStore` own focused configuration and
serialized transition UI. Draft is never a return destination after activation.

## Catalog discovery

`SessionCatalogStore` owns demanded activity-sorted summaries and cached ID/group
indexes. `WorktreeCatalog` is the shared authoritative Managed Worktree projection
keyed by Working Directory. Summaries retain stable directory and historical name;
all active lifecycle treatments join the catalog so Sessions sharing a checkout
expose the same controls. A pending creation record bridges acceptance to the first
projected record but never overrides it.

Collapsed active Project groups keep streams demanded. Discovery reads the Project
root and active/landed Managed Worktrees, not finished/discarded/missing worktrees.
Root and worktree metadata scans run concurrently and join one coherent bounded
initial snapshot; expanding a group does not restart discovery.

The resolved lane/groups initially collapse but their catalogs remain demanded
for the window lifetime. Resolved browsing reads routing metadata and Pi titles,
without Git/worktree discovery or runtime acquisition. Groups initially show ten
Sessions and reveal ten more per Show more. Mutations publish scoped events for
only the affected summaries, not catalog restarts on application-state revisions.

Pi session-name entries own titles, with first user message as display fallback.
Session IDs are canonical and duplicates reject. Active catalogs load resolved IDs
once and exclude them before reading transcripts for titles. Family catalogs include
all durable descendants even after checkout retirement. Root transitions refresh
derived descendant state without a member-resolution journal.

Resolution records contain Project, original Working Directory, and historical
worktree name, not transcripts. Existing archives are indexed once on Project
catalog initialization and returned to normal Pi storage while retaining resolution
metadata. Resolving changes only standalone/root metadata. After the last active
Session in a landed worktree resolves, Cake closes its terminals and removes checkout
and merged branch while retaining its record. Restore recreates required checkouts
before clearing resolution. Cleanup failures do not change inherited resolution;
resolving one of several active Sessions cannot retire their shared directory.

## Loaded identity and observation

`SessionRegistryStore` keeps one stable `ProjectSessionStore` per loaded ID, owns
keyed lookup and Session-ID/directory collision protection, and excludes Cake Chat.
`SessionObservationRetentionStore` owns selected/running/visible pins and a
process-local four-session idle LRU. Persisted loaded identity alone creates no
observation demand on restart. Selecting/opening/starting refreshes retention;
eviction stops observation and clears transcript data while preserving Store/Model
identity for rehydration.

Known targets observe Conversations directly. Discussion, review, subagent,
schedule, and artifact updates touch their focused Models and never rebuild a
Project Session payload or replace transcript identity.

## Staged input and saved drafts

`ProjectPendingSessionsStore` owns staged/temporary membership, pending summaries,
materialization, and relocation during directory choice. Each pending identity has
one `PendingConversationStore` holding window-persisted name, configuration, saved
prompt/attachments, status/resolution metadata, and timestamps.

An unsent pane is renderer state, not a Pi Session or catalog entry. New Chat
reopens its existing input/configuration/directory. Input persists continuously in
window state. First submission promotes the existing Store only after main accepts
start, keeps optimistic input visible, frees the staged slot, and holds a temporary
summary until catalog projection catches up. It does not wait for catalog discovery
or replace the visible Store.

Command-only first input attaches observation before acceptance, because a Pi command
need not persist transcript and start/turn leases cannot bridge promotion. Cancelling
a prepared start removes demand. Reopening an unlisted known identity prefers an
existing Pi transcript, otherwise it may recreate its empty runtime. Slash input
is not an optimistic user message; Pi decides whether it creates an entry.

Explicitly saving as Draft creates a cataloged pseudo-session with initial input
in Cake window state and shared Chat projection, and frees New Chat's staged slot.
A saved draft has no message input: only checkout/model choices and activation.
Its avatar assistant remains available without activation. Activation clears draft
state, retains the avatar, and hands transcript authority to Pi.

## Verification

- [Catalog workflow](../../tests/app/renderer/session-catalog-workflow.test.tsx)
- [Sidebar synchronization](../../tests/app/renderer/session-catalog-sidebar-sync.test.tsx)
- [Sidebar ordering](../../tests/app/renderer/sidebar-session-order-workflow.test.tsx)
- [Scoped catalog changes](../../tests/app/services/session-catalogs/SessionCatalogChanges.test.ts)
- [Session lifecycle contract](../architecture/s1-session-contract.md)
