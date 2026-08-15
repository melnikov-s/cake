# Pi 0.84.0 adapter contract

Cake pins `@earendil-works/pi-coding-agent` 0.84.0. The adapter contract tests
exercise these public APIs directly:

- `SettingsManager.inMemory()` and `SessionManager.inMemory()`;
- `DefaultResourceLoader`, inline extension factories, and `reload()`;
- `createAgentSession()` with an in-memory session and no enabled tools;
- `AgentSession.subscribe()`, `bindExtensions()`, `prompt()`, session identity,
  and `dispose()`;
- `ExtensionAPI.registerCommand()` and `sendMessage()`;
- `ExtensionCommandContext.ui.confirm()` through a Cake-owned UI adapter;
- `message_update` text deltas and displayed custom `message_end` events at the
  Pi-to-Cake projection boundary.

The foundation command is intentionally provider-free and deterministic. It
proves session lifecycle, extension binding, interactive UI routing, and event
normalization without requiring user credentials or making a model request.
Provider-backed assistant streaming uses the same adapter in the real workspace
session path. Live-provider acceptance remains opt-in because it requires user
credentials and may incur cost.

Only focused modules in `src/agent` import the Pi coding-agent package. Main,
preload, and the renderer's desktop-client boundary communicate with Cake-owned
types validated in `src/ipc`. The renderer boundary translates those DTOs into
intent-level `DesktopClient` operations and application events consumed by
focused renderer workflow Stores; those Stores do not depend on IPC types.

Pi's `/changelog` is an interactive-mode command rather than an
`AgentSession.prompt()` command. Cake handles it locally: the active workspace
driver reads Pi's bundled `CHANGELOG.md` through the public `getPackageDir()`
export, sends the markdown over validated IPC on demand, and renders it in the
shared command pane. It is never added to the session transcript or sent to a
model.

The extension UI adapter supports Cake's documented primitive React surfaces.
TUI-only methods fail with actionable compatibility diagnostics rather than
reporting false success. See `s3-pi-compatibility.md` for the current contract.
