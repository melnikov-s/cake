# Cake storage ownership

Cake resolves its persistent home once through `src/main/cake-paths.ts`. The
default is `~/.cake`; `CAKE_HOME` replaces that root for tests and alternate
installations.

```text
~/.cake/
├── plugins/
├── scenes/
├── recovery/
├── state/
├── pi/
│   ├── auth.json
│   ├── models.json
│   ├── models-cache.json
│   ├── settings.json
│   ├── sessions/
│   ├── review-sessions/
│   └── global-chat/
│       └── sessions/
```

Every production Pi adapter call receives `agentDir` and `sessionDir`
explicitly. Workspace sessions list, create, continue, open, preview, and fork
only beneath Pi's encoded per-workspace directories in `pi/sessions`. Review,
inline-discussion, and global-chat sessions have narrower roots under `pi/`, and direct
session-file opens are validated against the relevant Cake root. Pi still owns
the session engine and JSONL format.

Code-review and transcript-comment anchors and submission metadata share the
Cake review repository and one sidecar-session pattern. Their agent replies live
only in Pi review sessions. Live parent transcript projections and the unified
parent-readable thread index are disposable, rebuildable files beside that
metadata; they are not transcript authorities.

Window state persists the selected workspace and Pi session ID, never an
absolute session filename. On reopen, Cake resolves that ID through Pi beneath
the current Cake session root so changing storage roots cannot leave a second,
stale location authority in renderer persistence. Pi does not write a new
empty session's JSONL file until conversation content is flushed; if a saved
selection was never persisted, hydration replaces it with a fresh empty chat.

The Pi resource loader uses `pi/` for global settings, packages, extensions,
skills, prompts, themes, models, and authentication. It may also load trusted
project-local resources from the selected workspace. Cake injects its required
artifact extensions and `cake-plugin-authoring` skill independently. Nothing is
discovered from standalone `~/.pi/agent`.

## Electron user data retained

Application and window snapshots, artifact payloads, and review annotations
remain under Electron's `app.getPath("userData")`. Their location can be changed
by `app.setPath()` (the test override is `CAKE_ELECTRON_USER_DATA`) and is tied
to Electron's platform lifecycle. Review and global-chat Pi sessions live under
the Cake Pi roots above.
