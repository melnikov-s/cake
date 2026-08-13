# Agent-facing release migrations

## 2026-08-12 — Git-backed workspace changes

Cake's Changes surface now represents the current Git working tree rather than
reconstructing a session history from Pi `edit` tool results.

- `SessionChange`, `SessionSnapshot.sessionChanges`, and
  `SessionModel.sessionChanges` were removed.
- `ChangesStore.changes` is now the authoritative renderer projection and
  contains `ChangedFile` values received from Git inspection.
- `ChangedFile.status` is a semantic status value. It also exposes `staged`,
  `unstaged`, and optional `previousPath` fields.
- Code that focused a review by its old path should call
  `ChangesStore.focusPath(path)`; the Store resolves either side of a rename.
- The obsolete `refresh-session` desktop request and client method were removed;
  call `ChangesStore.refresh()` to refresh the Changes surface.
- The UI label changed from “Session changes” to “Workspace changes.”

Review sessions may edit the workspace directly again. The temporary
`request_main_edit` review tool and parent-session prompt routing were removed.
