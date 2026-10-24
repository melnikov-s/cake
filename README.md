# Cake

Cake is Pi expressed as a desktop GUI. Pi remains the coding-agent and session
engine; Cake adds a web-native conversation surface, rich artifacts and
workflows, navigation across projects and sessions, and a Pi-backed global chat
for reasoning about the application as a whole.

Cake is one application package with a shared backend, Electron and standalone
Node hosts, and sandboxed renderer clients. `src/backend` composes Cake's domain
operations and Services; `src/main` adds the native desktop host, `src/server`
provides the Node host, and `src/preload` exposes the narrow Electron transport.
Shared values live in `src/contracts` and the RPC protocol in `src/ipc`.
Regular Pi integration belongs in `src/services/pi`; permanent Cake Chat uses
Pi Durable through `src/services/pi-durable`. Legacy `src/agent` adapters are
migration debt, not the boundary for new integration.

See [Cake architecture](./docs/architecture/cake-architecture.md) for the product
and ownership model, and the [documentation map](./docs/architecture/README.md)
for focused contracts and documentation responsibilities.

## Color themes

In **Settings → Appearance**, choose **Light**, **Dark**, or **Follow System**, then pick a preferred theme for each mode from miniature Cake previews. Follow System switches between those saved favorites with your OS appearance. Click a card to preview it across the app; **Apply theme** saves that mode's favorite and **Cancel** restores your previous appearance. Editing the other mode's favorite does not change your appearance mode.

Bundled palettes include Cake Light/Dark, Solarized Light/Dark, GitHub Light/Dark, Catppuccin Latte/Mocha, Rosé Pine Dawn/Rosé Pine, Dracula, Nord, One Dark Pro, Tokyo Night, and five Cake dark palettes: Lifted macOS Graphite, macOS Vibrancy, Soft Slate, Twilight Steel, and Warm Titanium. Popular color data comes from the installed `@shikijs/themes` collection; macOS Vibrancy is a tinted palette, not native translucent window material.

You can also import a VS Code color-theme JSON/JSONC file. For themes with `include` files, select their containing folder (or select sibling files together), then choose the theme source. Imports copy color data only; no extension code is installed or executed. Imported themes are grouped by their light/dark type. Imported data, appearance mode, and both favorites use Cake's existing per-window settings persistence.

Cake maps workbench colors onto its semantic surfaces and derives chat/status colors with light/dark defaults. Embedded VS Code receives workbench, TextMate and semantic-token colors; Cake code blocks and diffs use TextMate colors for supported languages. The result is a matching palette, not a pixel-identical VS Code skin: Cake has different surfaces, syntax grammars can differ, and language-server semantic highlighting is editor-only. Legacy `.tmTheme` references, includes outside the selected source, fonts, icons, extension code and Marketplace installation are not imported.

## macOS app

Apple Silicon distribution builds use a drag-to-Applications DMG and manual
replacement updates. See [installation and releases](./docs/development/macos-distribution.md)
for download availability, first-launch macOS approval, prerequisites and release builds.
These builds are ad-hoc signed, not notarized; macOS download warnings still apply.

## Development

Requirements: Node.js 22 or newer and Corepack.

```sh
corepack pnpm install
corepack pnpm dev
```

Verification:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm lint
corepack pnpm build
corepack pnpm test:electron
```

For isolated user-visible performance collection and reviewed baseline comparisons,
see [performance checks](docs/development/user-performance.md).

Run `pnpm dev` for the normal Electron development loop. Renderer changes use
Vite hot module replacement; changes to main or preload rebuild and restart the
Electron process automatically.

Run `pnpm dev:agent` when an automation agent also needs to inspect or navigate
the Electron renderer. It exposes the development-only Chrome DevTools Protocol
endpoint at `http://127.0.0.1:9222`; Playwright can attach with
`chromium.connectOverCDP("http://127.0.0.1:9222")`. Do not expose that port in a
packaged build.

Run `pnpm dev:manual` to disable renderer HMR. Renderer edits become visible only
after choosing **Developer → Reload Cake** or pressing `CommandOrControl+R`.
Changes to main or preload still restart Electron automatically.

In local desktop mode, Electron main hosts the backend and Pi SDK runtimes.
Remote Electron connects to that backend on another host without acquiring a
local shadow backend. Regular Pi owns Project Session history in its session
files; Pi Durable owns the permanent Cake Chat coordinator's history and recovery
in SQLite. Cake projects both through shared conversation presentation, not a
second transcript store.

The renderer uses a hydration-gated `r-state-tree` `RootStore`. Window-owned
observers apply validated snapshots and events to focused projection Models.
Stores compose as stateful behavioral components for navigation, project/session
selection, chat, reviews, browsing, and other product surfaces. Their composition
reflects application ownership and lifetime; neither Store count nor window
lifetime determines whether responsibilities belong together.

For optional browser sharing and remote operation, including the current
single-user trust limitations, see the [host guide](./docs/development/headless-backend.md).

## Local MCP access

Cake includes an authenticated **Streamable HTTP MCP server** inside the desktop
app or standalone backend. Clients need no checkout, separate Node installation,
or bridge process.

1. Open **Settings → MCP servers → Cake MCP server**.
2. Turn on **Enable MCP server**.
3. Copy the **MCP client configuration** into your assistant's MCP settings.

**This grants full control of Cake, not sandboxed access.** Clients can use the
complete canonical Cake operation definitions: inspect conversations, send prompts,
launch work, change settings, manage Projects and worktrees, and use the other
available Cake operations. There are no MCP-specific Project or command allowlists.
Only enable clients you trust with Cake and the work its agents can perform.
Existing Cake/Pi trust checks, approvals and host capabilities still apply.

The server exposes exactly one tool, **`cake`**, using Cake's existing schema,
discovery, help, validation and execution:

```json
{ "command": "projects.list" }
```

Call `cake` with `{}` for topics, a topic such as
`{"command":"projects"}` for its operations, and
`{"command":"projects.rename.help"}` for an exact input contract. Invoke with
`{"command":"projects.rename","input":{"path":"/my/project","name":"My Project"}}`.
MCP uses global Cake Chat's context without its model-facing catalog curation;
use the ordinary `sessions.cake` command for
session-specific operations. Text, structured results and native image blocks
are preserved as returned by the registry. Launch/send receipts mean admission,
not completion; observe results through normal Cake operations or the app.

Cake generates an access token automatically: it is the server\'s password.
The copied client configuration includes it in the `Authorization: Bearer …`
header so the client can authenticate. Anyone with that token can control Cake
while the server is enabled; keep the configuration private.
**Reset access token** invalidates old configurations. Port, token and enablement
are saved on the backend and restored on restart. Existing scoped settings are
migrated to off rather than silently turning an old read-only grant into full
control; re-enable access explicitly after upgrading.

The listener binds only to `127.0.0.1`, at `http://127.0.0.1:4318/mcp` by
default. You can choose another port from `1` to `65535`; `0` is not accepted.
Previously saved automatic ports (`0`) are changed to `4318`. Every HTTP request requires the bearer token. Foreign Hosts and browser
Origin headers are rejected. Do not publish or tunnel this local listener.
Remote-desktop settings control the backend's listener, not the viewing device.

Apply port changes without restarting Cake. There is no restricted MCP mode:
turning the server off removes all MCP access. It closes MCP
sessions and interrupts unfinished calls, not already-admitted agent execution.
Cake must remain running. Calls are never automatically retried. Per-request
cancellation is not reliable for numeric request IDs in the pinned Effect MCP
implementation; subscriptions are not implemented.

Live provider tests are intentionally opt-in: signing in or sending a real
model request can open external authentication and incur provider cost.
