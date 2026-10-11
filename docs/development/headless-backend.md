# Headless backend and remote access

Cake can share a running desktop backend or run a standalone Node backend for browser
and remote desktop clients. This guide covers setup, exposure and recovery. Runtime
ownership belongs in [architecture](../architecture/cake-architecture.md); current APIs
and behavior live in [`src/server/`](../../src/server/) and their tests.

## Security and data isolation

**There is no Cake authentication or per-client authorization boundary.** Every accepted
client has full backend authority, including agent code execution. Host/Origin checks
prevent unintended browser-origin access; native clients can forge those headers.
Keep listeners private. Use an authenticated tunnel/reverse proxy and TLS for remote
access, protecting both the application and editor endpoints. This is one trusted
user's multi-view environment, not restricted sharing or a multi-user security model;
capability discovery and hidden UI actions do not establish access controls.

Do not run separate Electron and Node backend processes against the same data directory.
For an isolated standalone host, set both:

- `CAKE_HOME`: nonempty absolute path for Cake state, auxiliary Pi sidecars and cache.
- `PI_CODING_AGENT_DIR`: separate Pi agent home for primary sessions and credentials.
  `CAKE_HOME` alone does not isolate these.

Preconfigure projects and providers for a headless host without an interactive setup
client. Starting background workers can execute persisted due scheduled messages;
starting an empty data directory does not itself send a provider request.

## Share an already running desktop

Build with `pnpm build:slim` for non-native use, or `pnpm build` when bundled native
speech is needed. Both include browser assets. In **Settings → Network & privacy →
Browser sharing**, select a port (`0` chooses one) and enable sharing. The status shows
the actual URL; no restart is required. Desktop development builds need
`pnpm build:browser` if assets are absent.

Sharing is off at every desktop launch and binds loopback by default. `127.0.0.1` only
works on that computer. For a trusted device, explicitly use the host's concrete private
IPv4 address or an authenticated tunnel. The desktop control does not accept wildcard
binds. Browser clients cannot reconfigure desktop exposure.

Disabling sharing closes remote connections, not accepted local agent work. Closing
the last desktop window while serving keeps the backend alive; **Window → New Cake
Window** reopens the UI. **Quit Cake** stops the process and its turns. Keep the host
awake and reachable for remote work.

## Standalone build and launch

Use the Node version required by [`package.json`](../../package.json) and installed
repository dependencies:

```sh
pnpm build:server
CAKE_HOME=/absolute/path/to/isolated-cake-data \
PI_CODING_AGENT_DIR=/absolute/path/to/isolated-pi-agent \
  pnpm start:server
```

This starts **no network listener**. To enable RPC for native desktop clients:

```sh
CAKE_HOME=/absolute/path/to/isolated-cake-data \
PI_CODING_AGENT_DIR=/absolute/path/to/isolated-pi-agent \
CAKE_SERVER_ENABLED=true \
CAKE_SERVER_ALLOW_MISSING_ORIGIN=true \
  pnpm start:server
```

The host reports its actual bound address, normally `ws://127.0.0.1:4317/rpc`.
Port `0` selects an ephemeral port. Missing-Origin opt-in permits native clients;
it does not exempt a supplied Origin from validation.

`build:server` builds Node and browser output. `build:browser` rebuilds browser assets
only. Assets resolve under `out/browser/`, beside compiled output, not relative to
the launch directory. The server reuses installed Node packages: it is not a
self-contained deployment bundle. Missing assets or invalid configuration fail explicitly.

## Connect an Electron desktop

Build desktop and server from the **same source checkout** (`pnpm build:slim` and
`pnpm build:server`, or a full desktop build if native speech is needed). The connection
checks an exact source/dependency fingerprint, not a compatibility range.

In **Settings → Network & privacy → Cake backend**, enter the server's HTTP(S) or
WS(S) URL and choose **Connect on relaunch**. URLs normalize to `/rpc`; credentials,
queries, fragments and other paths are refused. TLS is never downgraded. Confirm
relaunch only after local work finishes: quitting stops local turns and sharing.
Remote accepted turns remain on their server.

Remote startup acquires the native window/menu/IPC host, not a local shadow backend,
Pi registry, project storage or workers. A failed connection offers Retry and
**Return to local**, also available in Settings. Remote navigation and unsent composer
drafts are device-local under `userData/remote-hosts/<endpoint-hash>/`, not the backend's
desktop window snapshot. Native menus, notifications, file picking
and external HTTP(S) links operate on the viewing device; project paths and terminals
refer to the backend.

Interactive provider setup keeps credentials on the backend and presents supported
manual/device-code flows on the initiating device. Extension-defined providers may
lack a suitable remote fallback. This is provider authentication, not Cake access control.
Disconnect cancels pending interactive setup; it is not automatically replayed.

### Remote VS Code

Install **code-server on the backend**, or set
`CAKE_VSCODE_SERVER_PATH=/absolute/path/to/code-server` in the backend environment and
restart it. The remote workbench requires code-server; Cake's managed openvscode-server
download is for local desktop viewing. Use the ordinary **Open in VS Code** action.

Remote desktop editor traffic uses a lease-scoped `/editor/` route on the same listener
as RPC. Only one desktop may hold a workspace editor lease; hiding retains it and
disconnect/close revokes it. Reopen deliberately after disconnect. This endpoint has
the same full-trust exposure as RPC. Browser VS Code instead requires a separate
origin; use the HTTPS configuration below rather than exposing a same-origin editor path.

### Backend development previews

The embedded Browser and CDP run on the **viewing desktop**. Ordinary
`http://localhost:5173/` is desktop-local. To deliberately view a service on the
backend's IPv4 loopback, enter `backend://localhost:5173/` in the remote desktop's
Browser address bar. This is an address-bar mapping, not a CDP navigation scheme.
Browser Mode/CDP is unavailable in the browser application.

The service must listen on backend `127.0.0.1`, on a port from 1024–9999. Cake forwards
it through `/preview/` on the existing endpoint to an isolated device-loopback origin;
no additional backend port needs public exposure. Carry both `/preview/` and `/rpc`
through the authenticated tunnel/proxy. Native bridge credentials are not Cake login.

Root assets and same-origin WebSocket/HMR paths work without a custom asset base.
Forwarding is bounded and does not support arbitrary ports, paths, cross-origin
redirects or companion services. Host-only cookies stay on the isolated preview origin;
Cake credentials are not forwarded. Closing/disconnecting revokes leases. These are
development previews, not a general reverse proxy or provider-login channel.

## Browser access

```sh
pnpm build:server
CAKE_HOME=/absolute/path/to/isolated-cake-data \
PI_CODING_AGENT_DIR=/absolute/path/to/isolated-pi-agent \
CAKE_SERVER_ENABLED=true \
CAKE_SERVER_BROWSER_ENABLED=true \
  pnpm start:server
```

Open the actual HTTP address printed at startup (normally `http://127.0.0.1:4317/`).
Browser serving allows exact same-origin WebSocket access by default. An explicit
`CAKE_SERVER_ALLOWED_ORIGINS` replaces that default. HTTPS is needed for secure-context
browser features outside loopback.

Each browser tab keeps its own navigation and unsent drafts in `sessionStorage` across
refreshes; closing the tab ends that state. Explicitly saved Draft records are shared
backend data. Native-only capabilities such as embedded Browser/CDP remain desktop-only.

### Browser VS Code behind HTTPS

VS Code must have a **different origin** from Cake, not `/editor/` on Cake's public
hostname. Example: one TLS proxy serves `cake.example.com` and `editor.example.com`
on 443, forwarding them to separate internal listeners:

```sh
CAKE_HOME=/absolute/path/to/isolated-cake-data \
PI_CODING_AGENT_DIR=/absolute/path/to/isolated-pi-agent \
CAKE_SERVER_ENABLED=true \
CAKE_SERVER_BROWSER_ENABLED=true \
CAKE_SERVER_BIND=127.0.0.1 \
CAKE_SERVER_PORT=4317 \
CAKE_SERVER_EDITOR_PORT=4318 \
CAKE_SERVER_ALLOWED_HOSTS=cake.example.com \
CAKE_SERVER_ALLOWED_ORIGINS=https://cake.example.com \
CAKE_SERVER_EDITOR_PUBLIC_ORIGIN=https://editor.example.com \
  pnpm start:server
```

Representative nginx routing, **in addition to authenticated access protection for both
hosts** and trusted TLS certificates:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
    listen 443 ssl;
    server_name cake.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
server {
    listen 443 ssl;
    server_name editor.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:4318;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Use exact public Host authorities, including non-default ports. The backend does not
infer external URLs from forwarded headers. To retain direct LAN app access, explicitly
add its exact Host and Origin to the corresponding allowlists. Never rewrite the editor
onto Cake's origin, strip WebSocket Origin headers, use wildcard CORS, or expose internal
listeners to untrusted clients. Separate origins isolate editor cookies/storage; separate
paths do not. The editor listener serves only active editor leases, not app assets or RPC.

### Server configuration

| Variable                           | Default                                            | Purpose                                                                                     |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `CAKE_SERVER_ENABLED`              | `false`                                            | Explicit network-listener opt-in.                                                           |
| `CAKE_SERVER_BIND`                 | `127.0.0.1`                                        | Bind interface/hostname; external binding must be deliberate.                               |
| `CAKE_SERVER_PORT`                 | `4317`                                             | Port, or `0` for an ephemeral port.                                                         |
| `CAKE_SERVER_BROWSER_ENABLED`      | `false`                                            | Serve browser assets; requires the listener enabled.                                        |
| `CAKE_SERVER_EDITOR_PORT`          | `0`                                                | Separate browser-editor listener; use a fixed port with a public editor origin.             |
| `CAKE_SERVER_EDITOR_PUBLIC_ORIGIN` | Unset                                              | Exact HTTPS origin, distinct from the app; requires browser assets and a fixed editor port. |
| `CAKE_SERVER_ALLOWED_HOSTS`        | Bound host/actual port                             | Comma-separated exact Host authorities; no wildcards.                                       |
| `CAKE_SERVER_ALLOWED_ORIGINS`      | None for RPC-only; same-origin for browser serving | Exact HTTP(S) origins without paths/trailing slash; explicit entries replace defaults.      |
| `CAKE_SERVER_ALLOW_MISSING_ORIGIN` | `false`                                            | Allow native clients without Origin; supplied origins still validate.                       |
| `CAKE_SERVER_MAX_PAYLOAD_BYTES`    | `1048576`                                          | RPC WebSocket message cap; see the configuration schema for bounds.                         |

## Disconnects and recovery

- Accepted turns continue after clients disconnect or sharing is disabled. **Stop**
  is separate. Regular-Pi Project turns and queues do not survive backend restart as
  live work. Permanent Cake Chat instead has Pi Durable-owned checkpoints and inbox
  recovery; reconnecting the transport supplies neither engine's execution recovery.
- Reconnect refreshes authoritative state without replaying mutations. If a send
  receipt is lost, inspect refreshed history before deliberately keeping or discarding
  the draft for resend. An uncertain receipt is not proof the prompt was rejected.
- An uncertain saved-Draft activation similarly requires transcript inspection and
  explicit recovery, not an automatic second activation.
- Terminal shells belong to their connection and close on disconnect; restarting is
  explicit. Editor and preview leases must also be reacquired deliberately.
- Pending device requests stay with their selected recipient and cancel on its loss.
  Another desktop deliberately opening/submitting in a session can become the recipient
  for subsequent requests; merely observing does not take control. This is one user's
  multi-view environment, not multiplayer access isolation.
- Generic local attachments are uploaded for backend use. Admitted files remain durable
  for Pi path references, including across restart; later turn rejection can conservatively
  retain an already-materialized file. A local device path is not a backend path.

## Verification commands

Use isolated data and controlled providers; these commands do not establish real-provider
login compatibility or platform deployment qualification:

```sh
pnpm test:integration tests/integration/network-rpc.test.ts tests/integration/network-server.test.ts tests/integration/headless-backend.test.ts
pnpm test:integration tests/integration/browser-chat.test.ts tests/integration/browser-assets.test.ts
```

For remote Electron checks, rebuild desktop and server from the same settled source first.
Follow [Electron testing](electron-testing.md) for hidden-window and targeted-test rules.
Keep deployment results, benchmark numbers and implementation history in artifacts.
