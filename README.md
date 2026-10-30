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

Other assistants can control a **running local backend** through a tools-only MCP
stdio bridge (macOS/Linux). It is off by default and opens no TCP/HTTP listener.
The build includes a dependency-free Node bridge; Effect's MCP server handles the
protocol in the running backend. No separate MCP server installation is needed.

1. Register the desired Projects in Cake. Trust them in Cake before using
   runtime-backed operations; MCP cannot grant trust or approve requests.
2. Fully quit Cake, then start the updated app with a host-owned grant. Replace
   these example paths with your private directory and exact registered Project
   roots (not managed worktree paths):

   ```sh
   export CAKE_LOCAL_MCP='{"directory":"/Users/you/.cake-mcp","projects":["/absolute/project"]}'
   pnpm dev
   ```

   Cake creates the endpoint directory with mode `0700`. An existing directory
   must already be private, owned by you and not a symlink. Choose a short path
   (the complete socket path must fit within 100 bytes). Invalid configuration or
   an occupied endpoint fails startup rather than widening access. After a crash,
   remove a stale `cake.sock` **only after confirming no Cake backend is using it**.

3. Add this server to your external assistant's MCP configuration:

   ```json
   {
     "mcpServers": {
       "cake": {
         "command": "node",
         "args": ["/absolute/cake/out/main/mcp-bridge.js", "/Users/you/.cake-mcp"]
       }
     }
   }
   ```

Use the `out/main/mcp-bridge.js` emitted by the desktop build (`pnpm build:slim`),
or `out/server/mcp-bridge.mjs` from `pnpm build:server`. The bridge can be copied
elsewhere: it needs Node, not Cake's source tree or `node_modules`. The package's
`cake-mcp` executable points to the desktop bridge when installed/linked as a CLI.

The assistant starts a small stdio proxy, not another Cake instance. Cake must
remain running. The proxy's stdout is exclusively MCP. For a standalone Node
backend, set the same environment on that backend host; a remote Electron client
does not acquire a second endpoint.

### Permissions and supported operations

Omitting `scopes` grants only `read`. Explicitly opt into additional scopes in
`CAKE_LOCAL_MCP`, then restart Cake, for example:
`"scopes":["read","launch","send","todos.write"]`. An empty array grants nothing.
All local clients of this endpoint share that startup grant; it is not per-client
authentication. Other OS users are excluded by the private directory. Programs
running as your OS user must be trusted. Unset `CAKE_LOCAL_MCP` and restart to
remove access, or remove individual scopes/Projects and restart to narrow it.

- **read:** `projects.list/info`, `sessions.list/info/history`,
  `sessions.reports`, `sessions.reports.read`, `todos.list/read`.
- **launch:** `sessions.create`, optionally using a managed worktree and a
  configured model/preset. Normal model defaults and trust checks apply.
- **send:** `sessions.send` to a canonical Project Session ID in the selected
  Project. Text only; no attachment, file, message-reference or thread forwarding.
- **todos.write:** `todos.create/update`; updates require `expectedRevision`.
  Work associations are preserved, not externally replaced. Done/reopen never
  resolves/restores sessions.

Use MCP `tools/list` for exact input schemas. Every call except `projects.list`
requires `projectPath`; Project restrictions and scopes are enforced on calls,
not just tool discovery. Session targets must belong to that Project; its own
Project Chat is readable, but global Cake Chat and other Projects are not.
Registry metadata can be read before trust; other calls require live Project
trust. Read access includes potentially sensitive conversation/to-do content.

Runtime operations delegate through the selected **Project Chat's existing Cake
operations**, so sends/launches are attributed to that chat and use its ordinary
notifications and task-input protections. Reports are that chat's **pending
report inbox**, not an archive of every result. Canonical results are returned
as MCP text (some operations contain JSON); a launch/send receipt means admission,
not completed work. Unregistered or ungranted tools return an MCP protocol error;
registered tool scope/schema failures set MCP `isError`. Canonical operation
responses, including `ok: false`, are preserved, so inspect the returned status. Observe completion through session status/history or Cake.
Disconnecting the proxy does not stop already-admitted work; unfinished calls
are interrupted, never automatically retried. Per-request cancellation is not
supported: the pinned Effect MCP implementation does not reliably cancel numeric
request IDs. Subscriptions are not implemented.

Launch/send authorize normal agent execution and provider costs, **not** a new
filesystem sandbox. Existing Cake/Pi tool permissions and approvals still apply.
There is no generic operation forwarding, settings/credentials access, shell,
trust/approval grant, merge, delete, stop or resolve tool. To-do association edits,
global chat access, remote authentication and tunneling are outside this version.
Do not publish or forward the socket over a network.

Live provider tests are intentionally opt-in: signing in or sending a real
model request can open external authentication and incur provider cost.
