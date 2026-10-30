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

Cake includes an authenticated **Streamable HTTP MCP server**. It runs inside the
installed desktop app or standalone backend; no checkout, Node installation,
bridge process or environment variable is required by clients.

1. Open **Settings → MCP servers → Cake MCP server**.
2. Select the registered Projects external assistants may access. Read access is
   selected by default; separately enable session launch, messaging or to-do edits.
3. Turn on **Allow external assistants**. Cake shows the live URL.
4. Copy the **MCP client configuration** into your assistant's MCP settings.

The configuration contains a bearer token: treat it as a password. **Reset access
token** invalidates old configurations; copy the new configuration afterward.
Projects, permissions, port, token and enablement are saved on the backend and
restored when Cake restarts. Apply edits without restarting Cake. Turning access
off closes the listener and invalidates its MCP sessions. Cake must remain running.

The server binds only to `127.0.0.1` (default port `4318`; use `0` to choose a
free port). Every HTTP request requires the bearer token. Foreign Hosts and
browser Origin headers are rejected. This is local access, not remote hosting;
do not publish or tunnel this listener. Browser/remote-desktop settings control
the backend's listener, not a second listener on the viewing device.

### Permissions and supported operations

- **read:** `projects.list/info`, `sessions.list/info/history`,
  `sessions.reports`, `sessions.reports.read`, `todos.list/read`.
- **launch:** `sessions.create`, optionally using a managed worktree and a
  configured model/preset. Normal model defaults and trust checks apply.
- **send:** `sessions.send` to a canonical Project Session ID in the selected
  Project. Text only; no attachment, file, message-reference or thread forwarding.
- **todos.write:** `todos.create/update`; updates require `expectedRevision`.
  Work associations are preserved. Done/reopen never resolves/restores sessions.

The server exposes one MCP tool, **`cake`**, with subcommands:

```json
{ "command": "sessions.list", "input": { "projectPath": "/my/project" } }
```

Call `cake` with `{}` to discover permitted commands, or pass
`{"command":"sessions.list.help"}` for the exact input schema. Topic commands such
as `{"command":"sessions"}` narrow discovery. Every subcommand except
`projects.list` requires `projectPath`. Project restrictions and permissions are
checked on calls, not just discovery. Session targets must belong to that Project; its own
Project Chat is readable, but global Cake Chat is not. Registry metadata can be
read before trust; other calls require live Project trust. Read access includes
potentially sensitive conversation and to-do content.

Runtime operations delegate through the selected **Project Chat's existing Cake
operations**, preserving attribution, notifications and task-input protections.
Reports are that chat's pending report inbox, not an archive of every result.
Launch/send receipts mean admission, not completion. Inspect canonical operation
status, including `ok: false`; observe completion through session status/history
or Cake. Subcommand errors set MCP `isError`; canonical operation results are
preserved unchanged. Changing permissions or resetting the token restarts MCP sessions,
not already-admitted agent work. Calls are never automatically retried.

Per-request cancellation is not supported reliably by the pinned Effect MCP
implementation for numeric request IDs. Subscriptions are not implemented.

Launch/send authorize normal agent execution and provider costs, **not** a new
filesystem sandbox. Existing Cake/Pi permissions and approvals still apply.
There is no generic forwarding, settings/credentials access, shell, trust or
approval grant, merge, delete, stop or resolve tool.

Live provider tests are intentionally opt-in: signing in or sending a real
model request can open external authentication and incur provider cost.
