# Standalone headless backend and RPC

The Node host runs the shared Cake backend without Electron, a display, or a
connected client. It uses the same storage, Pi runtime registry, project/worktree
services, client state, session workflows, scheduled-message worker and Session
Family worker as Electron. An **explicitly enabled** WebSocket endpoint now serves
headless chat/catalog RPC and, with a second explicit opt-in, basic browser chat.
Electron can also connect to that server using its normal desktop shell (see below).

## Share an already running desktop

Run the normal `pnpm build` (which now includes browser assets), then open
**Settings → Network & privacy → Browser sharing** in Cake. Set an available port
(or `0` to choose one) and enable **Enable browser sharing**. The status displays
the actual browser URL, normally `http://127.0.0.1:4317/`. No restart is needed.
This is a desktop-local host capability; browsers cannot reconfigure exposure.

Sharing is off at every desktop launch, is not persisted in window snapshots, and
binds loopback by default. `127.0.0.1` works only on that computer—not from a phone.
To connect a trusted device, explicitly enter the host computer's concrete private
network IPv4 address (wildcard binds are not accepted by this small desktop control),
or arrange an authenticated private tunnel. There is **no Cake authentication**:
all accepted clients have full host authority. The Settings warning remains visible
before enabling. Only exact same-origin browser access is accepted.

Enabling attaches the shared HTTP/WebSocket listener to the desktop's **existing**
backend Context. Projects, sessions and active turns are the same authorities;
there is no second backend acquisition or shared-data-directory subprocess. Failed
binds/missing assets show errors and can be retried. Desktop dev builds need
`pnpm build:browser` if the assets are absent.

Disabling closes remote connections only. Local IPC and accepted agent work continue;
re-enabling supports browser reconnection through new authoritative snapshots, never
mutation replay. Closing the last desktop window while serving keeps the process,
listener and backend alive. Activation or **Window → New Cake Window** reopens a
window on the same backend. **Quit Cake** finalizes the whole process. With sharing
disabled, normal platform-specific desktop exit behavior remains unchanged.

## Build and run

Use Node 22+ and the repository's installed dependencies:

```sh
pnpm build:server
CAKE_HOME=/absolute/path/to/isolated-cake-data pnpm start:server
```

This starts **no network listener**. `CAKE_HOME` is required, nonempty and absolute.
It uses the existing Cake directory layout (`state/`, `pi/`, `cache/`). Preconfigure
projects there. Provider credentials remain backend-owned; supported remote desktop
provider setup is presented on the initiating device (see below). A headless host
without a desktop client has no interactive provider setup UI. Do not
point separate Electron and Node processes at the same data directory concurrently.
This slice shares authorities within one host process, not between processes.

To explicitly enable loopback RPC for native clients:

```sh
CAKE_HOME=/absolute/path/to/isolated-cake-data \
CAKE_SERVER_ENABLED=true \
CAKE_SERVER_ALLOW_MISSING_ORIGIN=true \
  pnpm start:server
```

The host reports its actual bound address, normally `ws://127.0.0.1:4317/rpc`.
Port `0` requests an ephemeral port, useful for isolated tests.

**There is no Cake authentication or authorization boundary between clients.**
Every accepted connection has full backend authority, including access to backend
projects, credentials through agent operations, and code execution. Host/Origin
checks prevent unintended browser-origin access; they are not authentication and
native clients can forge those headers. Do not expose this port to an untrusted
network. Use a private authenticated tunnel/reverse proxy and TLS externally.

## Connect the desktop to a standalone server

Build **both** desktop and server from the same source checkout (`pnpm build` and
`pnpm build:server`). The desktop checks a source/dependency fingerprint, not a
compatibility range. Start the server with `CAKE_SERVER_ENABLED=true` and
`CAKE_SERVER_ALLOW_MISSING_ORIGIN=true`. Keep the listener on a trusted private
network or authenticated tunnel; there is no Cake authentication.

In **Settings → Network & privacy → Cake backend**, enter its `http`, `https`,
`ws`, or `wss` URL and choose **Connect on relaunch**. Confirm the native relaunch
warning only after local work finishes: quitting stops local turns and sharing.
Remote accepted turns continue on their server. URLs normalize to `/rpc`; credentials,
queries, fragments and other paths are refused. TLS is never downgraded. Only the
selected native WebSocket endpoint omits Origin; browser Origin checks are unchanged.

Remote startup acquires the actual native window/menu/IPC host, **not** a local
backend, Pi registry, project storage or workers. Failed connections offer Retry
and **Return to local**, also available in Settings. Native window presentation and
drafts are stored under the device's `userData/remote-hosts/<endpoint-hash>/`, never
in the server's window-state file or another host's snapshot. Reconnection restores
observations without replaying commands. An uncertain command receipt requires
checking refreshed state and explicit acknowledgment before further mutations.

This milestone supports projects/sessions, preconfigured models, chat/Stop/questions,
worktree domain operations, backend PTYs, and Draw storage with revision checks.
Terminal shells belong to their connection and close on disconnect; restarting is
explicit. This is not collaborative multi-user terminal ownership. Draw export
uses a native save dialog on the viewing device. Native menus, notifications and
HTTP(S) links remain device-local; VM file/custom-protocol links are refused.
The remote desktop supports an embedded VS Code workbench when **code-server** is
installed on the backend (see below). Backend-owned widget compilation and
refcounted companion modules publish transient capabilities through exact HTTP
asset routes; remote Electron resolves the existing sandboxed custom schemes
against those routes. Rendered review requests target the bound desktop, which
captures real settled pixels in its native offscreen window; no recipient or a
disconnect fails the pending capture rather than aborting accepted agent work.
Basic browser chat still shows widget text fallbacks and has no embedded Browser/CDP.
The remote desktop runs its embedded Browser/CDP on native Chromium (see below).
Supported interactive provider login uses backend-owned credentials and a targeted
initiating-device prompt/notice: the desktop presents manual codes, device codes and
verification URLs and opens eligible non-loopback URLs locally only when asked.
Disconnect cancels pending interactive setup; no login is replayed. Supported flows
include SDK manual-code fallbacks and device alternatives for the configured
providers; extension-defined providers without a suitable fallback are not
universally qualified. This is provider setup, not Cake account authentication.

### Remote desktop VS Code setup

Install `code-server` on the **backend machine**, not the viewing desktop. Cake
recognizes common installation paths or an explicitly configured
`CAKE_VSCODE_SERVER_PATH=/absolute/path/to/code-server` in the backend process's
environment; restart that process after changing its environment. The remote
workbench requires code-server: Cake's managed openvscode-server download remains
for **local** desktop viewing only. Set up the backend's project/trust state and
use the remote desktop's ordinary **Open in VS Code** action. A separate code-server
process is started on backend loopback for the workspace and is presented in a
native view on the remote desktop via a lease-scoped `/editor/` route on the same
network listener as `/rpc`. The route never grants arbitrary port or companion
access. The remote desktop does not read the backend's workspace/cache files or
launch its own editor server. Only one desktop can hold a workspace editor lease
at a time; hiding the view retains it, while disconnect/close revokes it. After a
disconnect, deliberately reopen the editor rather than replaying commands.

The editor route has the same **full-trust, no-Cake-auth** exposure as the RPC
listener. Use a private authenticated tunnel/reverse proxy and TLS when accessing
it from another machine; configure exact external Host and Origin values for that
proxy. Browser chat does not provide a VS Code surface.

### Remote embedded Browser and backend development previews

The remote desktop's **Open Browser Mode**, address, inspection and CDP tools use
Chromium on the viewing device. `browser.enter` targets the desktop currently
bound to that Project Session; a browser-chat observer cannot take its place.
With no bound desktop, the operation fails promptly. Browser views are window-owned:
a second desktop cannot silently move an open session's view. Closing the native
window releases its views; backend request correlation is cancelled on disconnect
without stopping an accepted Pi turn. Local desktop Browser Mode is unchanged.

An ordinary address such as `http://localhost:5173/` is **desktop-local**.
To deliberately view a dev server listening on the **backend's** IPv4 loopback,
enter `backend://localhost:5173/` in the remote desktop Browser address.
Cake checks the bound desktop/session, leases the backend loopback port through the
existing Cake listener's `/preview/<lease>/` route, and navigates native Chromium
to a distinct device-loopback `*.localhost` origin. A native-only bridge adds a
separate high-entropy credential to every forwarded request and WebSocket upgrade;
ordinary browser navigation on Cake's origin cannot load the preview. Absolute-root
assets and same-origin WebSocket/HMR paths work without a configured asset base.
The agent can inspect and interact with that page through the same `browser.cdp`
and `browser.events` commands. The `backend://` mapping is an address-bar action;
it is not a CDP navigation scheme. Navigation to a normal `localhost` URL never
silently forwards to the backend.

Preview service ports must be **1024–9999** and listen on backend `127.0.0.1`.
The bridge supports bounded GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS, request and
response bodies at most 16 MiB, and same-origin WebSockets (frames at most 1 MiB),
including HMR. It cannot reach arbitrary ports, file paths or Cake companion
routes. Up to eight session/port leases belong to the bound desktop; closure,
disconnect or listener shutdown revokes the original owner's leases and sockets.
Host-only cookies stay on the isolated preview origin, while Cake credentials,
bridge secrets and cross-origin redirects are not forwarded to the dev server.
These are **development previews**, not a general-purpose reverse proxy or
provider login channel.

The remote device only needs the already-reachable Cake endpoint, including
`/preview/` as well as `/rpc`; **no extra backend port is exposed**. The native
bridge binds a loopback-only app origin on the viewing device, forwarding across
the existing endpoint with normal TLS verification (HTTPS/WSS works through a
trusted certificate). Configure an authenticated private tunnel or reverse
proxy to carry both paths; the bridge credential is not Cake authentication.

## Basic browser chat

```sh
pnpm build:server
CAKE_HOME=/absolute/path/to/isolated-cake-data \
CAKE_SERVER_ENABLED=true \
CAKE_SERVER_BROWSER_ENABLED=true \
  pnpm start:server
```

Open **http://127.0.0.1:4317/** (use the actual port printed at startup if configured).
The server serves the compiled browser entry/assets and `/rpc` on the same port.
`build:server` builds both the Node host and browser assets; `build:browser` rebuilds
only the browser. Assets resolve beside the compiled host at `out/browser/`, not
relative to the process working directory. A missing build fails startup explicitly.
No arbitrary filesystem or source-map routes are exposed.

Choose a registered Project and active Project Session, or **New chat**. The browser
uses the authoritative shared Chat, ChatStore, configuration picker, transcript/tool
presentation and basic question/form controls. It supports preconfigured authenticated
models, typing/send and Stop. Sending during a turn uses the backend's ordinary prompt
admission policy. Sending waits for an in-flight model configuration change; first-prompt
configuration is captured once, with further choices unavailable until admission and its
authoritative snapshot settle. Project registration, provider login, attachments, archive management,
desktop native menus, VS Code, Draw, terminal and embedded browsing are not
browser features. Saved Draft records are shared backend state: the browser can
view/edit them with revision checks, activate one first turn, and observe another
client's committed changes promptly. Unsent edits and navigation remain tab-local. Widget requests show text fallback with a Skip action;
interactive widget/extension modules are not served. Desktop-only application controls
return explicit unavailability instead of waiting on an absent native host.

Each tab owns its navigation and unsent text **in memory only**. Switching sessions
within a tab retains drafts; refreshing/closing the tab loses them. No browser snapshot
is read from or written to desktop `window-state.json`. Transcript/catalog Models remain
projections of backend/Pi authority, never a browser-owned transcript copy. Connection
presentation belongs to the browser shell; each session's delivery workflow is
single-flight. A lost send receipt retains its draft, reports **delivery uncertain** and
blocks further submission until the user checks refreshed state and deliberately chooses
to discard or keep it for resend. Reconnection reacquires authoritative snapshots; neither
prompts nor other mutations are automatically replayed. Accepted turns continue after
all tabs close; Stop is separate. Pending questions cancel on socket loss, not resume.

Serving enables exact HTTP same-origin WebSocket access by default, so the command above
needs no Origin override. An explicit `CAKE_SERVER_ALLOWED_ORIGINS` replaces that default.
For HTTPS termination at a trusted proxy, configure its exact external Origin and Host
(including a non-default port). There is no wildcard, forwarded-header inference or
application authentication. Prefer an authenticated private tunnel; all accepted clients
have full backend authority. HTTPS is also needed for browser secure-context features
when not using loopback. HTTP requests check Host and any supplied Origin; navigation
and asset requests without Origin remain allowed. Duplicate authority headers are refused
for HTTP as well as upgrades.

### Configuration

| Variable                           | Default                                                                 | Meaning                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CAKE_SERVER_ENABLED`              | `false`                                                                 | Explicit opt-in; disabled mode acquires no listener.                                                                                                                     |
| `CAKE_SERVER_BIND`                 | `127.0.0.1`                                                             | Bind interface/hostname. External binding must be deliberate.                                                                                                            |
| `CAKE_SERVER_PORT`                 | `4317`                                                                  | Integer 0–65535; 0 returns an ephemeral port.                                                                                                                            |
| `CAKE_SERVER_ALLOWED_HOSTS`        | Bound host and actual port                                              | Comma-separated exact HTTP Host authorities. For a proxy or wildcard bind, explicitly list the externally used hosts, including non-default ports. No wildcard matching. |
| `CAKE_SERVER_ALLOWED_ORIGINS`      | None (RPC-only); exact HTTP same-origin when browser serving is enabled | Comma-separated exact `http://` or `https://` origins, without paths/trailing slash. Explicit entries replace the default. `null` is not accepted.                       |
| `CAKE_SERVER_BROWSER_ENABLED`      | `false`                                                                 | Serve the compiled basic browser client; requires `CAKE_SERVER_ENABLED=true`.                                                                                            |
| `CAKE_SERVER_ALLOW_MISSING_ORIGIN` | `false`                                                                 | Explicitly permit native clients that do not send Origin. Does not exempt a supplied Origin from validation.                                                             |
| `CAKE_SERVER_MAX_PAYLOAD_BYTES`    | `1048576`                                                               | Maximum WebSocket message size, 1024–16777216 bytes, including fragmented messages. Compression is disabled.                                                             |

Only `/rpc`, a live desktop's lease-scoped `/editor/`, and a native-credentialed
`/preview/` WebSocket endpoint accept upgrades. RPC query strings, unauthorized editor paths, and duplicate Host
or Origin headers are rejected before upgrade. Editor sockets have a 16 MiB
message cap independent of the configurable RPC cap. Browser HTTP serving is a bounded build
inventory, not a filesystem API; unknown/query/traversal paths return 404. There is no
upload endpoint or HTTP domain API. Malformed configuration and
bind failures fail startup with diagnostics. No listener starts on import/build.

The build bundles application source and raw prompts to `out/server/main.mjs` and
reuses installed Node packages; this is not a self-contained deployment bundle.
No editor, PTY process or provider request starts merely to boot an empty data
directory. Persisted due scheduled messages can intentionally submit work once the
background worker starts.

## Endpoint, identity, and lifetimes

`src/server/NetworkListener.ts` exports `openNetworkListener(options, configuration)`.
The caller must supply **already acquired backend Services** in its Effect Context.
The factory returns the actual address/path and an idempotent `close()` operation;
its enclosing Scope also closes it. It never constructs a backend. The Node host
provides `makeBackendLive` once and opens the endpoint within that lifetime.

The adapter uses the installed `NodeSocketServer.makeWebSocket`, Effect RPC socket
protocol, JSON serialization, and existing shared method definitions/handlers.
There is no new dispatcher, framing or replay engine. `BackendRpc` excludes window
snapshot persistence, native menus/dialogs, device-local
filesystem picking/read, Browser and capture operations. It includes server
workspace reads, bounded attachment uploads, VS Code, terminal, Draw, worktree
and sidecar domain groups for the remote desktop; the browser Client still refuses
its desktop-only operations. The local desktop's complete
`CakeRpc` still composes those groups with their original method names.

- Each actual socket has a host-assigned connection ID. Client-supplied connection
  and correlation headers, including casing variants, are replaced before dispatch.
- Actual disconnection clears only that connection's workspace association, pending
  project-trust response, composer reword request and pending UI interactions.
  Questions cancel truthfully; they are not resumed on another socket.
- Request/stream interruption cancels its request/subscription, not the socket.
- Accepted turns retain the existing `CakeSessionRuntimes` backend-owned lease.
  Disconnecting every client or closing the listener does **not** issue Stop.
- Reconnect with a new client and reacquire authoritative snapshots. Do not replay
  mutations automatically. A lost submission receipt is an unknown acceptance
  outcome; the adapter does not provide idempotent resubmission. The browser exposes
  uncertainty and requires deliberate reconciliation.
- SIGINT/SIGTERM close the process Scope and await backend finalizers. Effect's
  Node runner exits with status 130. Turns do not survive shutdown/restart.

`ClientConnections` is the single process-scoped trusted allocator for logical client
IDs across IPC and every network attachment. Socket IDs and native WebContents IDs
are distinct transport-local values, never client identities or reserved number ranges.
Native operations resolve an explicit logical-to-native mapping and still validate the
actual WebContents. Reconnection allocates a fresh logical identity; releasing a
connection removes only its own association and reverse requests. Simultaneous IPC
and sockets and sequential listener close/reopen are supported.

## Capability behavior and remaining work

Ordinary Project Session acquisition/chat requires no Electron, VS Code, Browser or
rendered-capture Service. Native operations reject explicitly when unavailable;
rendered-widget generation/review rejects before model work without a capture
Service or an eligible bound desktop recipient. Electron still supplies the real
native capabilities for local use.

This endpoint is not browser/remote-desktop parity. Browser observation/opening cannot
replace an existing desktop reverse-control recipient. Browser-only sessions explicitly
reject desktop-only reverse controls (including Draw) before enqueueing a request;
questions and supported structured responses retain recipient correlation and cancellation.
This is a single-user multi-view policy, not a multiplayer ACL or permissions system.
A successful desktop session open/start/prompt deliberately designates that desktop for
new session device requests; another desktop can deliberately change it. Merely observing
the transcript or catalog does not claim control. Each pending request remains bound to
the actual recipient chosen at dispatch, so changing controller never transfers or replays
an in-flight native command. Disconnect clears designation and fails pending device work
without aborting accepted server turns; browser-only/headless sessions have no eligible
native recipient. Shared transcript updates remain scoped to the project/session; direct
provider-auth UI and device actions remain connection-targeted, not broadcast with private
codes or credentials. Unsupported UI work must not be interpreted as successful desktop actions. Remote VS Code
presentation is code-server-only. Backend-owned rich-content routes serve only
live token-addressed documents/modules with the widget CSP and no filesystem
proxy; desktop native captures never run on the backend. Saved Draft records
live in backend `state/saved-drafts.json`: revision compare-and-swap, durable
single activation claim and initial legacy window-snapshot import precede local
record stripping. A crashed claim with no durable Pi turn evidence stays
uncertain; the user must inspect the transcript and explicitly release the claim
before retrying, never automatic replay. Any Pi catalog entry with a user
message completes the claim; a name-only entry does not prove turn acceptance. Desktop native file picking stays on the local device, while
workspace suggestions, text reads, and image previews run on the backend after
ProjectAccess and canonical-path checks. Selected files (8 MiB maximum) and pasted
images (15 MB maximum) transfer in base64 chunks of at most 192 KiB decoded bytes;
ordinary upload chunk limits remain 192 KiB and the default RPC message limit
remains 1 MiB; only a validated capture-response message may use up to 12 MiB
to admit an at-most-8-MiB PNG in base64. The server permits up to 20 staged
uploads per connection, 32 MiB reserved per connection and 64 MiB globally. Upload
references bind to the requesting connection; raw device file paths are rejected
by remote turn admission, while source/browser references retain their original
server semantics. Rejected, cancelled, or disconnected preparations are discarded, and unattended staging expires after 10 minutes. An
a file admitted to a turn request becomes a backend-owned durable state file
retained across disconnects and restarts for Pi's `@path` transcript semantics
(until user deletion). This conservative boundary also retains a file when later
turn work rejects after materialization, rather than deleting a path that an
uncertain Pi turn might already reference. Admitted images become ordinary Pi
image bytes, not durable upload files. The renderer
retains its original draft bytes until submission succeeds and never retries a
prompt after unknown receipt. Remote Electron uses an exact-build
handshake and its existing desktop create/fork workflows.
Basic browser navigation observes active sessions only; full desktop parity is not implied.

## Verification

`tests/integration/desktop-sharing.test.ts` attaches the production desktop sharing
Service and real Electron IPC adapter (controlled native event boundary) plus actual
WebSockets to one controlled backend. It retains real domain/runtime leases, proves
active-turn observation, disable/re-enable without Stop or reacquisition, bind recovery,
single-flight enables, noncolliding identities, wrong-recipient rejection, and preservation
of a desktop reverse request when a browser observes and disconnects. It also exercises
local IPC and remote Electron desktop designation through real RPC/domain activation,
wrong-recipient rejection, controller change, disconnect/unavailable and shared snapshots
with controlled Pi/native boundaries; this fixture does not prove actual Pi queue scheduling.
`tests/electron/desktop-sharing.smoke.spec.ts` runs the compiled Electron host and real
Chromium: Settings toggle, a preexisting Pi transcript in shared Chat, browser typing,
last-window close, native activation/reopen, disable/reconnect and explicit Quit. It uses
isolated data and no provider turn; live-provider behavior is not claimed by this smoke.

Final Saved Draft/headless and preview qualification on settled source also passed
`tests/integration/saved-drafts-browser.test.ts`, `saved-drafts-network.test.ts`,
`headless-session-controls.test.ts`, `preview-fixed-endpoint.test.ts`,
`preview-trusted-tls.test.ts`, and `preview-tls-target.test.ts`. Focused units
(55 tests/10 files) cover interrupted activation evidence, explicit recovery,
migration failures, desktop/browser projections and headless admission. After
`pnpm build` and `pnpm build:server` from the same checkout, six Electron cases
passed: local Browser, desktop sharing, legacy Draft restore/edit/activation,
remote Browser with preview HTTP/WebSocket, remote desktop, and remote failure/
local relaunch. Standalone browser tests use two real tabs and one backend turn.
The trusted HTTPS/WSS preview integration uses controlled certificates; real
Electron smoke uses HTTP/WS. Provider-auth UI/callback qualification uses
controlled provider fixtures; live OAuth/provider network or arbitrary
extension-provider parity is not claimed. Immutable originating-client affinity for
Pi's queued inputs is deliberately not required by the current desktop-controller policy;
multiplayer ownership is deferred, with no Pi SDK patch required.

The browser integration test uses installed Playwright Chromium headless shell against
an actual Node HTTP/WebSocket listener, production shared handlers/domain/runtime leases,
Stores and reducers. Only the external Pi/storage/worktree boundaries are controlled.
It tests real focus/typing, send, streamed tool/assistant state, Stop, a structured answer,
independent tab drafts, narrow layout, creation/model choice, pending configuration/admission
controls, and acceptance with a lost receipt followed by reconnect without replay. Separate production Node-host tests retain
production graph coverage; this does not claim live-provider browser qualification.

```sh
pnpm test:integration tests/integration/network-rpc.test.ts tests/integration/network-server.test.ts tests/integration/headless-backend.test.ts
pnpm test tests/app/server/networkConfiguration.test.ts tests/app/ipc/CakeRpcServer.test.ts
pnpm build:browser
pnpm test:integration tests/integration/browser-chat.test.ts tests/integration/browser-assets.test.ts
```

- The production Node host is built and started with Electron imports forbidden,
  isolated data and provider fetch forbidden. Two real Effect WebSocket clients
  mutate/read the same production application authority. Disabled startup and
  invalid `CAKE_HOME` regressions remain covered.
- Actual socket tests cover metadata forgery, recipient-only structured answers,
  isolated disconnect cleanup, request/stream interruption, listener closure and
  Host/Origin/path/payload refusal (including duplicate authority headers), idle
  socket shutdown without a peer close handshake, and startup configuration failure
  before backend acquisition.
- The deterministic turn test retains the production endpoint/handlers, real domain
  policy and `CakeSessionRuntimes`, replacing the external Pi adapter and storage/
  worktree boundaries. Two clients share one runtime; the accepted turn completes
  after all sockets disappear and a new connection sees its current snapshot without
  mutation replay. This narrower fixture does **not** prove production provider
  networking, Pi JSONL persistence, background workers or remote UI behavior.
