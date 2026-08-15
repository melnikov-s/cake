# Agent-facing release migrations

## 2026-08-14 — Session selection persistence

- `WindowViewState.selectedSessionFile` and the renderer `openWorkspace`
  `sessionFile` input were removed. Persist and reopen workspace sessions by
  `selectedSessionId`; Electron main resolves the authoritative Pi JSONL file
  beneath Cake's configured session root.

## 2026-08-13 — Persistent global chat

- `RootStore.globalChatStore` now owns Cake's application-level global-chat
  workflow. Custom scenes that want to open this surface should coordinate with
  the application shell rather than treating it as a project `SessionModel`.
- Global chat is backed by a hidden Pi session and does not appear in
  `SidebarStore.sessions`. Do not add it to project session lists or persist a
  duplicate transcript in renderer state.
- `DesktopClientEvent` includes dedicated `global-chat-*` events. These belong
  to `GlobalChatStore`; project transcript consumers should continue handling
  `session-*` and ordinary part events only.
- Application-control tool requests are routed through
  `RootStore.appControl`; custom scenes should expose new global actions by
  extending that curated bridge rather than handing the agent a Store tree.
- `RootStore.navigationStore` now owns the primary `chat`, `global`, and
  `settings` surface selection. Custom scenes should call its intent methods
  instead of maintaining a parallel shell-page value in React state.

## 2026-08-12 — Git-backed workspace changes

Cake's Changes surface now represents the Git tree captured by the active Pi
session branch rather than reconstructing history from Pi `edit` tool results.

- `SessionChange`, `SessionSnapshot.sessionChanges`, and
  `SessionModel.sessionChanges` were removed.
- `ChangesStore.changes` is now the authoritative renderer projection and
  contains `ChangedFile` values received from Git inspection.
- `ChangedFile.status` is a tree-comparison status value and exposes optional
  `previousPath` rename/copy metadata. The obsolete `staged` and `unstaged`
  fields were removed because checkpoints deliberately collapse index and
  working-tree state into one immutable tree.
- Code that focused a review by its old path should call
  `ChangesStore.focusPath(path)`; the Store resolves either side of a rename.
- The obsolete `refresh-session` desktop request and client method were removed;
  call `ChangesStore.refresh()` to refresh the Changes surface.
- `inspect-changes` requires the active `sessionId`. Cake appends
  `cake.git-checkpoint/v1` custom entries to Pi's session tree on first open and
  after settled work, then compares the first checkpoint with the latest one on
  the active branch.
- Checkpoints are full Git trees created through a temporary index. They include
  committed and uncommitted state, deletions, renames, and non-ignored new files
  without changing the user's index.
- Cake pins each tree under `refs/cake/checkpoints/`, so old sessions remain
  inspectable after ordinary branch deletion, commits, and history rewrites.
- Forks inherit checkpoints through Pi's native branched-session history. Tree
  navigation selects the checkpoints on the active branch.
- Existing sessions without checkpoint entries start tracking from their first
  open on this version; earlier filesystem state cannot be reconstructed.

Review sessions may edit the workspace directly again. The temporary
`request_main_edit` review tool and parent-session prompt routing were removed.
