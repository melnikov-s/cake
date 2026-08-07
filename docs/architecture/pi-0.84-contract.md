# Pi 0.84.0 foundation contract

Cake pins `@earendil-works/pi-coding-agent` 0.84.0. The S0 contract test in
`src/agent/pi-runtime.test.ts` exercises these public APIs directly:

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
Provider-backed assistant streaming remains Stage S1 work.

Only `src/agent/pi-runtime.ts` imports the Pi coding-agent package. Agent, main,
preload, and the renderer's desktop-client boundary communicate with Cake-owned
types validated in `src/ipc`. The renderer boundary translates those DTOs into
intent-level `DesktopClient` operations and application events consumed by
`WindowStore`; the Store does not depend on IPC types.

The S0 extension UI adapter implements `confirm`. Other primitive methods have
safe inert defaults where possible, while TUI-only methods fail explicitly.
Completing the remaining primitive UI adapter belongs to Stage S3.
