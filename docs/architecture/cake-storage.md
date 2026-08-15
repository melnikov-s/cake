# Cake storage ownership

Cake resolves its persistent home once through `src/main/cake-paths.ts`. The
default is `~/.cake`; `CAKE_HOME` replaces that root for tests and alternate
installations.

```text
~/.cake/
├── migrations/
│   └── pi-sessions-v1.json
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
only beneath Pi's encoded per-workspace directories in `pi/sessions`. Review
and global-chat sessions have narrower roots under `pi/`, and direct
session-file opens are validated against the relevant Cake root. Pi still owns
the session engine and JSONL format.

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

## One-time standalone-session import

Before Cake lists or continues sessions, it recursively copies
`~/.pi/agent/sessions` into `<Cake home>/pi/sessions`. This is a one-time,
copy-only migration: source entries are never modified, destination entries
are never overwritten, and conflicts retain Cake's content and are recorded in
the versioned completion marker. Missing sources are successful no-ops.

The completion marker is written atomically only after a successful traversal.
A partial failure leaves it absent, so startup can continue with any safely
copied files and retry idempotently next time. Symlinks and other non-file
entries are not followed. Settings, authentication, models, packages,
extensions, skills, prompts, and themes are never copied.

## Electron user data retained

Application and window snapshots, artifact payloads, and review annotations
remain under Electron's `app.getPath("userData")`. Their location can be changed
by `app.setPath()` (the test override is `CAKE_ELECTRON_USER_DATA`) and is tied
to Electron's platform lifecycle. Embedded-Pi session content formerly nested
there for reviews and global chat now lives under the Cake Pi roots above.
