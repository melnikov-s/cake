# Cake storage ownership

Cake resolves its persistent home once through `src/main/cake-paths.ts`. The
default is `~/.cake`; `CAKE_HOME` replaces that root for tests and alternate
installations.

```text
~/.cake/
├── migrations/
│   └── pi-sessions-v1.json
├── pi/
│   ├── auth.json
│   ├── models.json
│   ├── models-cache.json
│   ├── settings.json
│   ├── sessions/
│   ├── review-sessions/
│   └── global-chat/
│       └── sessions/
└── plugins/
```

Every production Pi adapter call receives `agentDir` and `sessionDir`
explicitly. Workspace sessions list, create, continue, open, preview, and fork
only beneath `pi/sessions`. Review and global-chat sessions have narrower roots
under `pi/`, and direct session-file opens are validated against the relevant
Cake root. Pi still owns the session engine and JSONL format.

The Pi resource loader uses `pi/` for global settings, packages, extensions,
skills, prompts, themes, models, and authentication. It may also load trusted
project-local resources from the selected workspace. Cake injects its required
artifact extensions and `cake-plugin-authoring` skill independently. Nothing is
discovered from standalone `~/.pi/agent`.

## One-time session migration

Before the first window opens or sessions are listed, Cake recursively copies
`~/.pi/agent/sessions` to `<Cake home>/pi/sessions`.

- The source is never moved, renamed, deleted, or modified.
- Missing files are copied with exclusive creation; existing files are never
  overwritten.
- Identical same-path files are accepted. Different same-path entries keep the
  Cake destination and produce a diagnostic recorded in the marker.
- A missing source is a successful no-op.
- The completed `migrations/pi-sessions-v1.json` marker is written atomically
  only after the entire traversal succeeds.
- If copying fails partway through, Cake logs an actionable error, continues
  startup using the safely copied destination, and retries next launch because
  the marker is absent. Exclusive copies and content comparison make retry safe.
- Once marked complete, later standalone Pi sessions are not imported. The two
  applications never share a session file or concurrent writer.

No settings, authentication, models, packages, extensions, skills, prompts, or
themes are migrated. Cake intentionally starts with isolated Pi authentication
and model configuration; the user signs in or configures providers in Cake.

## Electron user data retained

Application and window snapshots, artifact payloads, and review annotations
remain under Electron's `app.getPath("userData")`. Their location can be changed
by `app.setPath()` (the test override is `CAKE_ELECTRON_USER_DATA`) and is tied
to Electron's platform lifecycle. Embedded-Pi session content formerly nested
there for reviews and global chat now lives under the Cake Pi roots above.
