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

Live provider tests are intentionally opt-in: signing in or sending a real
model request can open external authentication and incur provider cost.
