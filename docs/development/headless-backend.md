# Headless backend and remote access

Cake can share a running desktop backend or run a standalone Node backend for browser
and remote desktop clients. This guide covers setup, exposure and recovery. Runtime
ownership belongs in [architecture](../architecture/cake-architecture.md); current APIs
and behavior live in [`src/server/`](../../src/server/) and their tests.

## Security and data isolation

**Desktop sharing can require Google sign-in and a server-enforced account allowlist.**
Without that option, including the standalone Node listener, Cake has no authentication
boundary: keep listeners private or behind an independently authenticated TLS proxy.
Host/Origin checks alone are not authentication; native clients can forge those headers.
Every approved/accepted client has full backend authority, including agent code execution.
This is a trusted user's multi-view environment, not restricted sharing or per-project
permissions. Google-protected sharing does not expose editor or development-preview
proxy routes; protect any separately configured services independently.

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
Remote access**, select a port (`0` chooses one for private sharing) and enable sharing. The status shows
the actual URL; no restart is required. Desktop development builds need
`pnpm build:browser` if assets are absent.

Sharing is off at every desktop launch and binds loopback by default. `127.0.0.1` only
works on that computer. For a phone, prefer the private HTTPS path below rather than
binding to all interfaces. The desktop control accepts an optional **Proxy HTTPS origin**;
this derives exact Host/Origin allowlists and displays the configured HTTPS URL. It does
not start TLS, configure a proxy, or prove reachability. Leave it empty for ordinary direct
HTTP access. A concrete private IPv4 address is also an explicit trusted-network option;
wildcard binds are refused. Browser clients cannot reconfigure desktop exposure.

Disabling sharing closes remote connections, not accepted local agent work. Closing
the last desktop window while serving keeps the backend alive; **Window → New Cake
Window** reopens the UI. **Quit Cake** stops the process and its turns. Keep the host
awake and reachable for remote work.

## Phone browser access over public Tailscale Funnel and Google sign-in

Tailscale must be installed and authenticated **on the host computer**. The phone
needs only a browser. Cake does not install Tailscale, enable Funnel, change host
networking, or create Google credentials. Keep the host awake, online, and running
Cake and Tailscale. Disabling sharing does not disable your separately configured Funnel.

1. Find the host's exact HTTPS Funnel origin, for example
   `https://laptop.your-tailnet.ts.net`. Do not publish the Cake listener yet.
2. Create a Google OAuth **Web application** client for personal use. Configure its
   **Authorized JavaScript origins** with that exact origin and its **Authorized
   redirect URIs** with `https://laptop.your-tailnet.ts.net/auth/google/callback`.
   Add intended Google test users if the consent app is in Testing. Cake uses Google
   Identity Services' redirect ID-token flow, not API-access/refresh tokens; it needs
   the web client ID, **not a client secret**.
3. On the host, open **Settings → Network & privacy → Remote access**. Keep bind
   **127.0.0.1**, use a fixed port such as **4317**, enter the exact HTTPS origin,
   and turn on **Require Google sign-in**. Enter the Google web client ID and one
   approved email address per line in **Allowed Google accounts**, then save.
4. Enable sharing in Cake **with Google sign-in required**, then explicitly configure
   Funnel yourself to forward to the loopback listener, for example
   `tailscale funnel --bg http://127.0.0.1:4317`. Confirm Tailscale's actual URL and
   port match Cake's configuration. Never forward an unprotected listener.
5. Scan Cake's QR code or open its URL on the phone. The QR contains only the normal
   URL, not a session or bypass credential. Sign in with an approved Google account.
   The displayed URL is configured, not a reachability test.

Google's [redirect validation rules](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)
require an exact HTTPS callback and a public-suffix hostname. The public suffix list
includes `ts.net`. Google's [brand verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)
provides personal-use/testing exemptions, but this is not a promise that Google will
accept every tailnet hostname or consent configuration. Verify your exact origin and
callback in Google's console before relying on this setup. Public/verified app branding
has additional domain-ownership requirements; this feature does not bypass them. If
Google refuses your configuration, stop setup rather than exposing Cake without login.

The host verifies Google's token signature, issuer, audience and expiration with Google's
server library, and requires a verified email and a single-use browser-bound nonce plus
Google's CSRF token. On first approved sign-in, Cake durably pins that email to Google's
stable `sub` identifier; a later different account cannot inherit that approval by
reusing the email. Removing/re-adding an email does not erase the binding.

Cake sessions use opaque, HttpOnly, Secure, host-only cookies and expire after seven days.
Use **Settings → Network & privacy → Sign out of Cake** in the browser to revoke the
current session. Save an account removal on the host to revoke all its sessions and
close its active WebSockets immediately. Turning sharing off or restarting Cake revokes
all sessions; accepted agent work is not cancelled. Access administration is available
only through host desktop controls, not network RPC. Approved accounts nevertheless have
full agent execution authority, so they must be trusted with the host itself.

The authentication boundary runs before all application assets, resource routes and RPC
upgrades. Only the minimal Google login page and callback are public. Exact Host/Origin
checks remain in force; Google cross-origin POST is admitted only on the exact callback
and still requires the nonce/CSRF checks. Editor and preview endpoints are refused on
this listener, and no separate browser-editor listener is acquired. Native remote
Electron authentication through this Google browser-cookie flow is not supported.

## Phone access over private Tailscale HTTPS

This initial access model trusts your own devices; it does **not** add Cake login,
device pairing, restricted users, a managed relay, or standalone public remote access.
Private VPN access is sufficient only when its access policy restricts this service to
trusted devices. A compromised or otherwise permitted device has full laptop authority.
Host/Origin validation is browser-request protection, not authentication.

Configure networking yourself; Cake never installs Tailscale or changes host networking:

1. Put the laptop and phone on your private Tailscale network. Restrict the service with
   your tailnet access policy to your trusted devices/user. Do not assume that every
   member of a shared tailnet is trusted. Enable HTTPS certificates for your tailnet
   if required by Tailscale Serve. **Do not use Funnel** (public exposure).
2. On the laptop, arrange private Tailscale Serve to forward HTTPS to the IPv4 loopback
   port you chose, for example `tailscale serve --bg --https=443 http://127.0.0.1:4317`.
   Use `tailscale serve status` to find the actual HTTPS origin. Serve's private access
   controls are the access boundary; do not forward router ports or open a public listener.
3. In Cake desktop **Settings → Network & privacy → Remote access**, keep bind
   **127.0.0.1**, choose fixed port **4317** (or your proxy target port), enter the exact
   origin, e.g. **https://laptop.your-tailnet.ts.net**, and enable sharing. No path or
   trailing slash is accepted. Sharing remains off at each Cake launch.
4. Open the displayed HTTPS URL on the phone with Tailscale connected. The laptop must
   remain awake, online and running Cake; closing its lid may suspend it. Closing a Cake
   window is not quitting Cake. Stop sharing in Settings when finished; separately disable
   Serve if no longer wanted (`tailscale serve --https=443 off`).

With a proxy origin configured, only that exact Host authority and HTTPS Origin are
accepted; direct `http://127.0.0.1:4317/` access is intentionally refused. Local desktop
IPC continues unchanged. The status shows the actual internal bind/port and the
**configured, not reachability-tested** external URL. A `403 Unexpected Host/Origin`
means the URL or proxy's preserved Host/Origin does not match; fix the exact values,
not a wildcard or missing-Origin bypass. Forwarded headers are never used to infer trust.
If the port is busy, choose another fixed port and change the proxy target to match.

For standalone browser hosting use the same loopback bind and set
`CAKE_SERVER_ALLOWED_HOSTS=laptop.your-tailnet.ts.net` and
`CAKE_SERVER_ALLOWED_ORIGINS=https://laptop.your-tailnet.ts.net` with the browser/listener
opt-ins below. Include non-default public ports exactly in both values when used.

### Other authenticated HTTPS proxies

An external proxy must require authentication **before serving any Cake assets, RPC
WebSocket upgrades or editor endpoints**, preserve the original exact Host (including
non-default port) and Origin, support long-lived WebSocket upgrades, and use trusted TLS
certificates. Keep internal listeners inaccessible to untrusted clients, normally on
loopback. A proxy's login must work in the phone browser before the WebSocket connects;
redirecting an unauthenticated WebSocket to a login page is not a usable login flow.
Never rewrite an arbitrary client's Origin to the allowed value or strip it. Do not
publish a bare unauthenticated HTTPS proxy: encryption alone does not provide access control.

The desktop proxy field supports the Cake conversation UI. Browser VS Code additionally
needs a separately protected HTTPS origin and fixed editor listener; use the standalone
configuration in **Browser VS Code behind HTTPS** below. Do not proxy the desktop's
random HTTP editor port onto the Cake origin. Clipboard, notifications, uploads and
on-screen keyboard behavior depend on browser/platform permissions and secure context.

### Phone acceptance checks

Browser viewport/touch emulation is not physical-phone verification. Before relying on
this setup, check on your actual iOS Safari or Android Chrome device:

- Open and dismiss navigation; switch Project Sessions and Cake Chat; reach Settings.
- Focus the composer, type multiple lines, select text, send, and dismiss/reopen the
  keyboard in portrait and landscape. Confirm the composer and Send remain visible
  above the keyboard/browser chrome and safe-area insets, including with large text.
- Lock/unlock, background/foreground, change Wi-Fi/mobile data, and briefly disconnect
  Tailscale. Confirm state refreshes and the unsent draft remains. Accepted work must
  not be replayed; if delivery is uncertain, inspect history before acknowledging it.
- Confirm an untrusted device cannot reach the service, and that disabling sharing or
  quitting Cake disconnects it. Test proxy-auth expiry/sign-in and denied access separately.

Browser resume starts a fresh transport instead of trusting a suspended half-open socket;
only observations retry. Tab-local drafts survive ordinary refreshes, but browser eviction,
closing the tab or clearing site data may discard them. This is not offline editing.

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
