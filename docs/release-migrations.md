# Agent-facing release migrations

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
