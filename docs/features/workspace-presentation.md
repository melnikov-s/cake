# Workspace presentation and creation workflows

## Workflow owners

`ProjectWorkbenchStore` coordinates accepted Project opens and Session selection.
`ProjectOpenStore` owns picker/inspection, trust decisions, active Working Directory
persistence, and latest-result concurrency. `SessionPresentationStore` coordinates
Agent/VS Code/browser/Draw transitions, suspend/restore, Draw flushing, and native
presentation events.

`ProjectSessionCreationStore` composes `WorktreeCreationStore` for background
creation and first-send activation; Managed Worktree creation precedes Session
creation and pending identities stay in `ProjectPendingSessionsStore`.
`ProjectSessionPlacementStore` owns registration, runtime-open-before-command,
failed-open cleanup, and optional pane placement for forks/family children.
`SessionRetirementStore` owns history/layout/registry/fallback cleanup after main
accepts resolve/delete; `ProjectRemovalStore` does equivalent deregistration cleanup.
Focused management Stores retain transition serialization.

## Panes and secondary chats

The Project `SessionLayoutStore` owns a persisted binary split tree, divider ratios,
focused pane, and per-pane navigation. Splitting relative to focus prepares an unsent
Project chat in the same Working Directory. Sidebar targets focus; selecting a
Session already visible elsewhere focuses it rather than duplicating it. Every
visible pane pins its Conversation observation. Cake Chat is a permanent singleton
with an independent one-pane layout that cannot split, not another Project layout.

Each primary pane has one transient side-chat slot. Selection chats and Subagent
Sessions replace its contents, not the persisted split tree. Wide panes show a
resizable right-side chat; narrow panes temporarily replace only the parent chat.
Selection and width live with the primary Session's Store and are not persisted.
Command-pane, extension, and editor operations target focus where applicable.

Embedded VS Code replaces Project split presentation without destroying its layout.
`EmbeddedEditorStore` owns native lifecycle, bounds, and Source Control navigation.
VS Code and Draw share workspace/chat layout: editor/canvas left, optional ordinary
sidebar, authoritative Chat in the right drawer. Per-Session presentation preference
and chat-drawer geometry belong to `ProjectSessionStore`. Switching presentation
does not create a Conversation.

## Terminals and retirement

The window terminal dock follows the focused Project pane's Working Directory.
Tabs are keyed by canonical directory: shared checkouts share terminals; Managed
Worktrees remain isolated. `WorkingDirectoryRetirementStore` owns transient
preflight/confirmation shared by resolve, discard, and bulk cleanup. Main owns
all-window terminal inspection/closure; `TerminalStore` blocks/releases only local
projections. Resolving one Session preserves terminals; directory retirement or
discard closes the entire collection.

Managed Worktree landing/recovery is main-owned domain behavior. Renderer Stores
start/retry/dismiss and project it. Accepted merge-and-resolve intent persists in
the worktree record until main resolves the directory; terminal acknowledgement is
independent cleanup and cannot gate resolution.

## Independent creation and continuation

`WorktreeCreationStore` coordinates staged disposition, checkout choice, and
create-worktree-before-named-session for Cake Chat and singular `session.create`.
Without `worktreeName`, the latter creates an independent Project Session at the
Project root. With it, Cake registers the worktree before starting Pi there.

Forks create detached Pi Sessions and may target a child Managed Worktree based
on the current checkout, the Project root, or a new worktree based on the default
branch. Resolution is separate; an already resolved source remains resolved.
Tool Compact is not continuation and keeps the existing identity/directory.
For recursive children and landing permissions, see the
[Session Family contract](../architecture/session-family-contract.md).

## Verification

- [Worktree workflow](../../tests/app/renderer/worktree-workflow.test.tsx)
- [Creation workflow](../../tests/app/renderer/worktree-creation-workflow.test.tsx)
- [Landing domain](../../tests/app/domain/worktreeLandings.test.ts)
- [Workspace/chat primitives](../development/component-catalog.md#workspace-and-chat-shell)
