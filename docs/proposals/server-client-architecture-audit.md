# Cake server/client architecture audit

Status: proposal and source audit, not an implemented feature.

Audited checkout: `cb5644c3`. The working tree was clean at the start of the audit.

## 1. Agreed product target

One authoritative Cake backend, with two client experiences:

- **Electron:** the full desktop experience, connected either to a local backend or to a backend on another machine. A locally running Electron application can enable network access to its existing backend while it continues running; no restart, session migration, or separate server launch is required. The desktop, phone browser, and other clients then operate on the same runtime and storage.
- **Browser:** project/session navigation and ordinary chat, including streamed tool activity, prompt/queue/steer/stop, and basic structured questions. No embedded VS Code, Draw editor, terminal, or embedded browser initially.
- **Headless server:** runs on a VM without Electron, a display server, or a connected client. Pi, credentials, repositories, Git, worktrees, session history, and application storage live here.

No Cake accounts, login, roles, or restricted sharing in this milestone. Remote serving is explicitly enabled; loopback is the default bind address. A network binding grants full backend authority to anyone who can reach it. Origin/Host checks, payload validation, sandboxing, and bounded inputs remain transport requirements, not authentication.

Not included: simultaneous collaborative document editing, offline operation, cross-machine filesystem synchronization, agent execution surviving a server restart, or a cloud control plane.

## 2. Executive finding

**Feasible by separating existing responsibilities, not by replacing the renderer or Pi.** The core RPC, projection, storage, and runtime foundations are useful as-is.

The critical path is not VS Code remote editing. It is:

1. Remove Electron from the backend dependency graph.
2. Separate a client connection from an Electron `WebContents` identity.
3. Move authoritative workflows out of renderer callbacks where they must work without a client.
4. Separate server resources from desktop-local presentation and persisted client state.
5. Add and verify a network transport and headless build.

A browser-chat demo is materially smaller than completion of that target. No calendar estimate is justified by this source audit alone.

### Important corrections to the initial discussion

- Accepted agent turns **already** retain a runtime and run in the service Layer's Scope. Disconnect survival is partly implemented, not an architecture we must invent.
- VS Code already runs as a separate Node server. We need to split its hosting from its Electron view and expose its connection, not implement remote editing.
- Draw storage already rejects stale revisions. It does not need a new collaboration engine for single-client desktop editing.
- Full remote desktop parity includes less obvious dependencies: widget capture, custom URL schemes, provider-login interactions, local file attachments, and agent browser controls.
- Browser feature hiding alone does not make the backend headless: several ordinary session-composition paths still require Electron.

## 3. Findings and source evidence

### A. Backend startup is mixed with desktop startup

[MainLive](../../src/main/MainLive.ts) assembles storage, Pi, worktrees, renderer requests, widgets, VS Code, Browser, Electron, and the RPC server in one graph. [MainApplication](../../src/main/MainApplication.ts#L55-L157) waits for Electron readiness, starts native protocols/windows, and handles native window cleanup. [main.ts](../../src/main/main.ts) obtains Electron user-data paths, native theme, and bundled assets.

Some domain operations also require actual windows:

- [projects.ts](../../src/domain/projects/projects.ts#L85-L97) resolves a connection to `WebContents`. Project inspection, active-working-directory association, trust responses, and composer rewording use this machinery.
- [projectSessionRuntime.ts](../../src/domain/project-sessions/projectSessionRuntime.ts) requires Electron and VS Code during runtime composition; Browser is optional, but its installed implementation is Electron-specific.
- [ProjectSessionRuntimeHostLive](../../src/services/pi/ProjectSessionRuntimeHostLive.ts) requires Electron for event publication and widget capture for generated-widget review.
- [ModelHandlers](../../src/ipc/server/ModelHandlers.ts) uses Electron to notify and open provider authentication URLs.

**Change:** extract a backend composition and startup program with no runtime Electron imports. Keep native windows, dialogs, theme, menus, protocol registration, and view cleanup in a desktop host. Do not introduce a fake/no-op Electron Service to make headless composition typecheck.

`BootstrapLive`, most storage Services, project access, Git/worktrees, catalogs, scheduling, and Pi resource ownership can remain. Inspect import reachability, not just which Layers are instantiated: session integrations import custom-protocol modules that themselves import Electron.

### B. RPC is reusable; connection identity is not yet portable

[CakeIpcServer](../../src/ipc/server/CakeIpcServer.ts) already has thin, grouped handlers and shared schemas, but supplies `ElectronRpcServerProtocolLive` directly. [renderer/runtime.ts](../../src/renderer/runtime.ts) similarly hard-wires the Electron client protocol. [renderer/main.ts](../../src/renderer/main.ts#L27-L36) refuses to boot without preload.

[ElectronRpcServerProtocol](../../src/ipc/transport/ElectronRpcServerProtocol.ts) derives connection IDs from `event.sender.id`, overwrites client-supplied identity/correlation headers, and observes `WebContents` destruction. [RendererConnectionMiddleware](../../src/ipc/protocol/RendererConnectionMiddleware.ts) assumes those injected headers.

The pinned Effect RPC implementation already includes `RpcClient.layerProtocolSocket`, `RpcServer.layerProtocolWebsocket`, and WebSocket protocol construction. Reuse them; do not create another RPC dispatcher, stream framing protocol, or cancellation system. The current dependency set includes `@effect/platform-node-shared`, not the complete Node HTTP server package; HTTP hosting/build dependencies need an explicit choice at the pinned Effect version.

**Change:** protocol-independent backend handlers; a server-assigned client-connection context and connection lifecycle; network protocol wiring with equivalent trusted metadata assignment. Never trust a browser-supplied connection header. Local desktop operations must not appear on the remote backend API.

Add a small server identity/build/capability handshake. Browser assets come from the server; a separately installed Electron client must report an understandable incompatible-build error rather than fail through arbitrary schema errors. No compatibility framework or legacy protocol support is needed.

### C. Accepted turns already outlive the submitting request

[CakeSessionRuntimes](../../src/services/pi/CakeSessionRuntimes.ts#L405-L476) shares runtimes through `RcMap`. Its [turn acceptance path](../../src/services/pi/CakeSessionRuntimes.ts#L581-L669) takes a private runtime lease and forks work into the service Layer Scope. Releasing an observer is not the same as aborting an accepted turn.

Its [observation path](../../src/services/pi/CakeSessionRuntimes.ts#L567-L579) subscribes before taking the initial snapshot. [observe-stream.ts](../../src/renderer/observers/observe-stream.ts) already retries observations. These foundations should remain.

**Change:** preserve these lifetimes through the network adapter and prove them across actual socket disconnection. Distinguish disconnect, explicit Stop, desktop exit, and server shutdown.

Reconnect by reacquiring authoritative snapshots, not by adding a Cake transcript journal. A lost response after submission is an **unknown acceptance outcome**, not proof of failure. Initially do not automatically replay mutating commands; report uncertainty, refresh authoritative state, and allow deliberate retry. If seamless retry is later required, add bounded command-specific idempotency rather than a generic durable command bus.

### D. Reverse requests currently have one mutable renderer binding

[RendererRequestCoordinator](../../src/services/renderer-requests/RendererRequestCoordinator.ts#L198-L359) stores one connection per session; `bind` overwrites it. Publication calls Electron directly. [ProjectSessionHandlers](../../src/ipc/server/ProjectSessionHandlers.ts) binds on open/start; [SessionChatHandlers](../../src/ipc/server/SessionChatHandlers.ts) binds on prompt/steer/follow-up. [Connection release](../../src/services/renderer-requests/RendererRequestCoordinator.ts#L744-L758) removes bindings and settles pending requests as cancelled.

Consequences with two clients:

- Merely opening a session can redirect UI work away from the desktop that was using it.
- A basic browser can become the target for an operation it cannot perform.
- Losing a connection can cancel a question/control request even though the agent turn remains alive.

**Change:** keep observation membership separate from control targeting. Connections advertise supported client capabilities and loaded-session context. Opening a read projection must not steal control. Correlate a pending request with its actual recipient; a later selection change must not retarget it.

Recommended first policy:

- Generic interactive requests target the initiating client when available.
- Desktop-specific requests require an explicitly associated capable desktop; use an unambiguous eligible desktop only, otherwise return a clear capability/unavailable result.
- No connected capable client means immediate explicit unavailability, not an indefinite wait.
- Pending requests cancel with a truthful result on recipient loss in the first slice. Seamless question recovery is a separate enhancement; do not claim questions survive disconnect until they have snapshot-backed resumption.
- Existing wrong-connection and wrong-session response rejection remains.

The existing coordinator can be refactored for this role. A new messaging platform is unnecessary.

### E. Some agent workflows depend on a renderer even when the operation is not UI

[projectSessionRuntime.ts](../../src/domain/project-sessions/projectSessionRuntime.ts) sends CreateSession, CreateDraft, ForkSession, and worktree merge/discard application controls through a renderer. By contrast, family child creation already performs domain work before requesting optional presentation.

[ProjectSessionCreationStore](../../src/renderer/stores/ProjectSessionCreationStore.ts#L63-L157) sequences worktree creation and session start. This is fine as a presentation workflow while the UI is alive, but insufficient for a headless agent's authoritative create-session operation. Cake Chat application controls have the same general renderer-dependence and need command-by-command classification.

**Change:** separate durable/domain actions from navigation/presentation. Reuse existing domain operations for creation, continuation, landing, and lifecycle; move only orchestration that must survive the caller away from Stores. UI still owns optimistic rows, progress presentation, focus, and placement.

A headless agent must be able to create/fork/start work without a client. It need not be able to open a Draw canvas without one. Do not move all renderer logic into the server or port the entire application-control interpreter wholesale.

### F. VS Code is a concrete split, not an editor rewrite

[VsCodeServerRuntime.startServer](../../src/services/vscode/VsCodeServerRuntime.ts#L878-L969) launches code-server/OpenVSCode on loopback with a workspace, Cake companion extension, and private bridge settings. [openNext](../../src/services/vscode/VsCodeServerRuntime.ts#L518-L601) also resolves paths, acquires the server, creates a `WebContentsView`, loads its loopback URL, and injects Cake shell controls. [VsCodeServerLive](../../src/services/vscode/VsCodeServerLive.ts#L78-L253) ties server resource ownership, native views, theme, and Electron events together.

**Server retains:** binary installation/discovery, remote OS/platform facts, workspace resolution, process/cache ownership, editor HTTP/WebSocket endpoint, companion extension, review/source commands, and private loopback bridge.

**Desktop retains:** native view construction/bounds/visibility, focus, shell controls, and local theme preference. Its view loads the remote endpoint instead of desktop loopback.

Expose the editor through a tested proxy/forwarded endpoint; arbitrary URL prefix rewriting is not assumed to work. Validate WebSockets, assets, tokens, redirects, and the actual supported server flavor. The companion bridge stays private on the backend machine; Cake RPC carries the relevant commands/events.

One additional multi-client detail is real: [companion routing](../../src/services/vscode/VsCodeServerRuntime.ts#L1088-L1182) currently identifies workspace and broadcasts events; companion ports are keyed by workspace. Selection, focus, and annotation interactions need an editor-instance/client target. Either support that identity end-to-end or initially allow one active Cake-controlled editor owner per workspace. Do not promise independent simultaneous editor control without testing the companion behavior.

### G. Terminal execution is already separate from presentation

[TerminalLive](../../src/services/terminal/TerminalLive.ts) owns `node-pty` through `TerminalManager`; it does not require Electron. Input, resize, and events are scoped by numeric owner. [MainApplication](../../src/main/MainApplication.ts#L75-L96) currently closes an owner's terminals when its window closes.

**Change:** execute PTYs on the backend and distinguish desktop-client lifetime from a transient transport connection. For a dependable remote desktop, retain client-owned terminals through a bounded reconnect interval, reattach them to that client, and make any lost output explicit or provide bounded replay. Explicit tab close, workspace retirement, expiry, and server shutdown release them. Terminal tabs need not be shared between different desktops.

The smaller initial prototype can close terminals on disconnect if it clearly says so. That is not equivalent to a fully reconnectable desktop terminal. No terminal support is needed in the browser client.

Verify Node-hosted PTY loading and spawning on the intended VPS platform. Existing Electron tests do not prove the Node/Linux deployment path.

### H. Draw is mostly reusable; embedded browsing stays desktop-local

[DrawBoardStorageLive](../../src/services/storage/DrawBoardStorageLive.ts#L205-L248) serializes saves and checks `expectedRevision`. Board storage and Excalidraw presentation already have the useful split.

Keep Draw editing in Electron, board persistence on the backend, and route agent Draw operations to that desktop. Preserve revision-conflict handling; no CRDT or multiplayer canvas is required. Browser capability discovery must not advertise Draw editing.

[BrowserLive](../../src/services/browser/BrowserLive.ts) and `BrowserRuntime` genuinely operate native Electron views and CDP. Keep this browsing runtime on the desktop, including agent CDP requests routed through the client capability channel. With no desktop, those operations are unavailable.

For VM-hosted preview applications, explicitly forward selected remote ports. Desktop `localhost` is not server `localhost`. Generic preview forwarding is a separate endpoint policy from VS Code hosting, though the forwarding machinery may be reusable. Running an autonomous server browser with no desktop is outside this initial target.

### I. Rich content has hidden Electron dependencies

[inline-widget-protocol.ts](../../src/services/widgets/inline-widget-protocol.ts) publishes an in-memory document under `cake-widget:`. [extension-companion-protocol.ts](../../src/services/pi/runtime/extension-companion-protocol.ts) does the same for `cake-extension:`. Their consumers include Pi runtime integrations, not only optional UI imports. [inline-widget-contract.ts](../../src/ipc/inline-widget-contract.ts) validates the exact custom scheme, and the renderer CSP explicitly names both schemes.

[RenderedWidgetCapture](../../src/services/widgets/RenderedWidgetCapture.ts) uses a hidden Electron `BrowserWindow` for generated-widget visual review. Even its Service/error definitions share a module with that native implementation.

**Change:** separate document/module publication and contracts from Electron protocol serving. Serve compiled documents/modules through backend routes, preserving widget sandboxing, CSP, token/source checks, and distinct trust treatment for trusted extension code versus model-presented widget data. Update contract validation and desktop CSP without broadly opening arbitrary script origins.

For full remote desktop behavior, request widget capture from the connected Electron host. This reuses the existing capture implementation and avoids requiring Chromium on the VM. With only basic browser/no client, rendered-review generation can report unavailable while ordinary transcript fallback remains usable. Server-side headless Chromium is an optional later capability, not a prerequisite for chat.

### J. Attachments and provider setup need correct machine semantics

[WorkspaceFilesLive](../../src/services/filesystem/WorkspaceFilesLive.ts) combines remote workspace reads with native attachment dialogs. Image attachments carry bytes, but generic file attachments carry a path. [session-projection.ts](../../src/services/pi/runtime/session-projection.ts#L910) turns a file attachment into an `@path` reference.

**Change:** keep workspace suggestions/reads on the backend; move local picking to the client. Desktop-local generic files need an explicit bounded upload/materialization contract, not a local path sent as if it existed on the VM. Keep remote workspace references distinct. Materialize uploads in owned server storage with a defined cleanup policy, not silently in repository files. Downloads save on the viewing device; workspace exports remain backend writes.

Provider credentials remain server-owned. Provider auth URLs must open on the viewing device. Redirect/callback flows that assume loopback may need forwarding or a provider-supported manual/device flow; preconfigured server credentials are sufficient for the first slice. This is provider setup, not adding Cake login.

### K. Window persistence cannot be globally shared

[WindowStateStorage](../../src/services/storage/WindowStateStorage.ts#L1058-L1129) writes a single `window-state.json` under Electron user data. [PendingConversationStore](../../src/renderer/stores/PendingConversationStore.ts) snapshots saved-draft content/configuration as well as local workflow state.

**Change:** separate three categories:

| State                                                   | Authority/owner                                           | Lifetime and persistence                                                      | Concurrency                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Transcript, accepted turns, session/catalog facts       | Pi + backend domain Services                              | Existing Pi files and focused Cake storage; turns are server-process lifetime | Existing per-session admission and domain policies                                   |
| Explicitly saved drafts                                 | Backend draft workflow/storage; renderer projects records | Durable shared product records, no Pi transcript until activation             | Revision-checked edits; one authoritative activation                                 |
| Navigation, pane layout, scroll, unsent input           | Focused client Stores                                     | Client-scoped snapshot, namespaced by backend identity                        | Independent clients; no whole-tree synchronization                                   |
| Connection, capability advertisement, request recipient | Backend client-connection boundary/coordinator            | Transient connection or explicit reconnect lease                              | Server-assigned identity; correlated completion                                      |
| PTY and editor process                                  | Backend resource Services                                 | Server-process resources with client attachment/lease policy                  | Commands target explicit resource/client; workspace retirement remains authoritative |
| Native menu, view bounds, focus                         | Desktop host and existing presentation Stores             | Desktop/window lifetime                                                       | Local latest-state policy                                                            |
| Draw document                                           | Backend board storage + editor-owned working document     | Existing saved board snapshots                                                | Existing expected-revision conflict, not collaborative merge                         |

Do not copy transcripts into client persistence. Do not apply another client's Store snapshot to an already-mounted Store. Preserve r-state-tree mount-time hydration and ordinary Store/Model boundaries.

First browser chat can omit saved-draft management. Before calling all session records available across devices, move saved drafts to the backend and explicitly migrate existing saved data; simply relocating the whole snapshot would lose or incorrectly share product state.

## 4. Recommended target architecture

```text
Browser shell                         Electron shell
  shared Chat / ChatStore               shared full React UI / Stores
  browser-local presentation            local preload + desktop host
         |                                      |          |
         | network RPC                          | RPC      + native menus/views/capture
         +----------------------+---------------+
                                |
                      Cake backend RPC handlers
                      client events / requests
                                |
                 domain operations + focused Services
              Pi | files | Git | storage | PTYs | VS Code server
```

### Composition decisions

- Keep existing local IPC for a local Electron-hosted backend initially. Allow an optional network listener alongside IPC, attached to the exact same acquired backend Services and runtime registry. Enabling it while a turn is running must not construct a second backend or reacquire the session independently. Disable network access by closing the listener and its client connections, not by shutting down the local backend or aborting accepted work. Do not force a separate local child process just to ship remote access.
- While network serving is enabled, closing the last desktop window must not implicitly quit the hosting application. Explicit Quit still shuts down the embedded backend and disconnects remote clients; continued hosting after application exit would require a separately managed process and is not promised. The host computer must remain awake and reachable.
- Add a standalone Node server entry point built from the same backend graph. No Electron import in that graph, including transitive runtime imports.
- Remote Electron boot assembles desktop-local Services and connects to the remote backend; it does **not** also acquire local Pi runtimes/storage for the remote session.
- Split desktop-host commands/events from backend commands/events. The Promise-based renderer Client can compose both through typed semantic operations, but a menu action never goes to the remote server.
- Keep native context menus in Electron. Browser menus use shared UI primitives or simpler explicit actions; they do not need desktop parity.
- Browser bootstrap uses a capability-limited shell and the authoritative `Chat`/`ChatStore`. Do not clone a transcript/composer or subclass the desktop RootStore into a second application framework.
- Gate observers, restoration, keyboard actions, application controls, and agent capability discovery—not just toolbar buttons. Current bootstrap unconditionally subscribes to VS Code/native event channels, and `SessionPresentationStore` restores remembered native modes.
- All paths in backend commands denote backend paths. Client OS, clipboard, theme, and downloads remain client facts. For example, editor installation availability cannot be inferred from the remote viewer's user agent.

### Exposure defaults

Server mode is opt-in and unauthenticated as requested. Bind loopback by default and require explicit external binding. A private/authenticated tunnel can provide protection outside Cake. No session URL is an access-control boundary. Serve assets/RPC through a known origin, validate Host/Origin at the network boundary, and preserve sandboxed rich-content isolation. HTTPS/tunnel termination is advisable for remote browser secure-context APIs, independently of login.

## 5. File-level change map

Proposed new files below are responsibility boundaries, not a requirement to create all abstractions before the first slice.

| Area                          | Existing files affected                                                                                                                                                                                     | Result                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Composition/startup           | `src/main/{main,MainLive,MainApplication,BootstrapLive}.ts`, `src/config/CakePaths.ts`                                                                                                                      | New `src/server/` entry/composition; desktop-only lifecycle remains in main; explicit backend data/assets paths            |
| Backend transport             | `src/ipc/server/CakeIpcServer.ts`, `src/ipc/protocol/{CakeRpc,RendererConnectionMiddleware}.ts`, transport/client modules                                                                                   | Transport-independent handlers; WebSocket adapter; server-assigned client context; separate desktop RPC group              |
| Client events/control         | `src/services/electron/{ElectronLive,NativeEvents}.ts`, `src/services/renderer-requests/RendererRequestCoordinator.ts`, relevant RPC handlers                                                               | Transport-neutral client event publication and capability-aware request routing; native event producers stay desktop-local |
| Project/session orchestration | `src/domain/projects/projects.ts`, `src/domain/project-sessions/projectSessionRuntime.ts`, `src/services/pi/ProjectSessionRuntimeHostLive.ts`, relevant creation/continuation Stores and Cake Chat controls | Remove window identities from domain operations; headless domain actions separate from presentation                        |
| Editor                        | `src/services/vscode/{VsCodeServer,VsCodeServerLive,VsCodeServerRuntime}.ts`, `src/assets/vscode-companion/extension.js`, editor handlers/client                                                            | Backend hosting/bridge versus desktop native presentation; remote endpoint; targeted companion events                      |
| Terminal                      | `src/services/terminal/{TerminalLive,TerminalManager}.ts`, terminal handlers, `TerminalStore`, disconnect cleanup                                                                                           | Backend PTYs with explicit client ownership and reconnect behavior                                                         |
| Desktop browsing              | `src/services/browser/{BrowserLive,BrowserRuntime}.ts`, Pi browser controls                                                                                                                                 | Desktop-hosted browser; reverse capability requests; remote preview forwarding                                             |
| Documents/capture/files       | widget and extension protocol modules, `RenderedWidgetCapture.ts`, `WorkspaceFilesLive.ts`, widget contracts, CSP                                                                                           | Network-reachable rich content; desktop capture; machine-correct uploads/downloads                                         |
| Renderer                      | `src/renderer/{main,runtime}.ts`, `client/{Client,ClientCapabilities,ClientLive}.ts`, `observers/events.ts`, presentation/control Stores and shell components                                               | Host-aware bootstrap, shared chat, browser capability gates, local-versus-backend routing                                  |
| State                         | `WindowStateStorage.ts`, renderer persistence, `PendingConversationStore.ts`, pending-session collections                                                                                                   | Client-scoped presentation storage and server-owned saved drafts                                                           |
| Build/deployment              | `electron.vite.config.ts`, `package.json`, standalone server build configuration and assets                                                                                                                 | Node server output, browser assets, companion resources, native PTY deployment verification                                |

**Preserve:** Pi APIs/session files, conversation schemas/reducers, `Chat`/`ChatStore`, runtime lease/turn mechanics, Git/worktree engine, most storage implementations, Draw revision checks, React UI primitives, and scoped observer infrastructure. Update ownership documents after the architecture is implemented; this proposal does not redefine current production behavior.

## 6. Ordered implementation slices

### Slice 1 — headless backend + minimal browser vertical slice

1. Extract connection/event interfaces and remove native imports from the minimal backend graph, including widget/extension publication modules.
2. Separate desktop-only RPC operations from backend handlers. Reuse the domain operations, not stubbed fake success responses.
3. Add standalone Node build/startup, backend configuration, static browser assets, and Effect WebSocket transport.
4. Boot a browser shell with shared chat, registered-project/session navigation, model choice, and prompt/stop. Start with preconfigured projects/provider credentials; unsupported tools must return explicit capability results.
5. Prove a deterministic running turn continues with zero observers, then rehydrate a reconnecting client.

Acceptance: real Node process with no Electron/display requirement; real browser RPC; one session/runtime; authoritative snapshot after reconnect. A fake Pi/provider boundary is appropriate for deterministic tests, but the actual backend graph and transport must be exercised.

### Slice 2 — full remote Electron connection

1. Compose desktop host and remote backend Client without starting a second local backend for that connection.
2. Route native menus/links/notifications locally; use a server-path picker for remote repositories.
3. Split VS Code host/view and proxy its network endpoint; route companion events correctly.
4. Connect terminal UI to remote PTYs and implement the declared reconnect policy.
5. Connect existing Draw UI to remote board storage and route Draw requests to that desktop.
6. Preserve desktop browsing/CDP via client capability routing and deliberate preview forwarding.
7. Support remote widgets/extensions, desktop rendered capture, and local file uploads/downloads.

Acceptance: full desktop workflows operate on VM resources; local filesystem paths are never mistaken for VM paths. A basic browser can observe the same session without stealing desktop-specific operations.

### Slice 3 — headless workflow completion and multi-client correctness

1. Move create/fork/worktree orchestration needed by agents behind authoritative backend operations.
2. Split saved-draft authority from client snapshot persistence; migrate existing data without overwriting unrelated client state.
3. Complete capability checks, targeted reverse requests, unavailable-client outcomes, and per-client presentation restoration.
4. Finish reconnect/uncertain-submission UI and server/client build mismatch handling.

Acceptance: background agents can continue domain work with no clients; unsupported presentation is explicit; clients do not overwrite drafts/navigation or redirect each other's pending interactions.

### Slice 4 — deployment and regression qualification

Run the targeted automated coverage below, then a Linux/VPS deployment smoke with an actual remote Electron client. Verify both local desktop and remote mode, Node/native dependencies, HTTP/WebSocket forwarding, assets, and graceful server shutdown. Mobile basic chat receives a focused layout/input pass; rich desktop parity on mobile is not part of the target.

## 7. Named verification cases

Prefer real domain/Store/projection behavior with deterministic external fakes. Use Deferred/Queue/TestClock for coordination, not sleeps. Network and Electron integration tests belong in their appropriate integration suites.

### Backend and transport

- `headless_boot_has_no_electron_runtime_dependency`: production server build/import/start succeeds in Node without Electron; optional desktop operations report unavailable.
- `two_clients_share_one_pi_runtime`: two observers plus a command acquire one runtime, not per-client copies.
- `enable_desktop_serving_during_active_turn`: enable the network listener without restarting Electron; a browser observes the existing turn, sharing the desktop's backend and session identity.
- `disable_desktop_serving_preserves_local_work`: remote connections close, but local IPC, the desktop conversation, and accepted turns continue.
- `desktop_window_close_keeps_enabled_server_alive`: closing the last native window preserves remote access while serving is enabled; explicit Quit still performs backend shutdown.
- `accepted_turn_survives_last_socket_disconnect`: wait for acceptance, close all connections, complete controlled provider work, reconnect and observe the authoritative result.
- `explicit_stop_still_aborts_after_reconnect`: disconnect is not abort; Stop remains abort.
- `reconnect_replaces_projection_from_current_snapshot`: changes made while offline appear without duplicated messages or replayed commands.
- `lost_prompt_receipt_does_not_auto_resubmit`: simulate acceptance followed by response loss; one turn runs, UI reports uncertain delivery until reconciliation.
- `connection_metadata_is_server_assigned`: forged connection/correlation headers cannot redirect replies or complete another pending request.
- `headless_create_fork_and_worktree_actions_do_not_require_renderer`: retain real domain sequencing and rollback with fake external Services.
- `server_shutdown_releases_runtime_editor_and_pty_resources`: no orphan processes; do not assert process-restart continuation.

### Client ownership and interaction

- `browser_observation_does_not_steal_desktop_control`: opening/observing a session leaves desktop-specific routing intact.
- `unsupported_capability_returns_without_waiting`: browser-only/no-client Draw, editor, browser-CDP, and capture requests terminate with a clear result.
- `pending_request_accepts_only_its_recipient`: another client's response or subsequent selection cannot settle the wrong request.
- `disconnect_settles_pending_interaction_truthfully`: assert the selected cancellation policy, not an invented successful answer.
- `client_snapshots_are_isolated_by_backend_and_client`: two clients edit unsent input and layout independently; backend switching does not cross-hydrate them.
- `saved_draft_is_shared_and_activates_once`: saved record visible across clients; stale edits rejected; simultaneous activation cannot create two sessions.
- `browser_restoration_never_enters_unsupported_native_mode`: a known session remembered in Draw/VS Code elsewhere opens chat in the browser.

### Full remote desktop

- `remote_editor_loads_assets_and_websocket_through_endpoint`: exercise actual code-server/OpenVSCode integration separately from companion unit tests.
- `remote_editor_selection_targets_originating_client`: source navigation, selected text, side chat, annotations, and theme do not leak to a second desktop.
- `remote_terminal_runs_in_server_workspace`: verify actual PTY host and working directory in the deployment integration test.
- `terminal_reconnect_preserves_declared_lease_and_output_policy`: transient network loss versus explicit close/lease expiry, plus workspace retirement.
- `draw_remote_save_preserves_revision_conflicts`: sequential saves succeed; stale second writer gets the existing conflict rather than silently overwriting.
- `desktop_local_file_upload_is_readable_by_remote_agent`: bytes materialize on the backend; no desktop absolute-path assumption.
- `remote_widget_render_and_capture_preserve_sandbox`: published document loads remotely, capture comes from desktop, model content cannot access Cake RPC through its frame.
- `remote_preview_forwarding_does_not_reinterpret_localhost_silently`: explicitly selected server port versus desktop browsing.

### UI smoke/regression

Browser Playwright tests are appropriate for the explicitly new web surface. Verify actual typing, retained input, enabled send, stop, question submission, reconnect messaging, and narrow/mobile viewport navigation.

Rebuild before Electron tests. Reuse the existing focused smoke cases for session chat, slash commands, project opening, file links, VS Code selection/source control, Draw, terminal, inline widgets, and widget capture. If shared Chat changes, include normal project chat plus the affected secondary chat and slash-command keyboard handling. No full unrelated e2e run is needed per slice.

## 8. Remaining experiments, not reasons for more broad auditing

1. **Node build/import boundary:** prove the extracted backend can boot without transitive Electron imports and with bundled prompt/companion assets. This is the first implementation gate.
2. **WebSocket connection context:** prove server-assigned identity, disconnect cleanup, stream re-observation, and uncertain mutation outcomes with the pinned Effect transport. Do not infer behavior from its reconnect option alone.
3. **Remote VS Code endpoint:** prove the actual supported binary through a proxy/forwarder, then source selection/annotation targeting. Independent extension hosts/client IDs must be tested rather than assumed from workspace identity.
4. **Node/Linux PTY and packaging:** verify against the intended VM environment, not only macOS Electron tests.
5. **Provider auth callback:** test only the configured providers whose login flows must run remotely; preconfigured credentials unblock the first slice.

These are narrow implementation experiments. Further repository-wide reading is unlikely to improve the plan as much as executing them.

## 9. Audit verification and limits

Source inspection covered startup/composition, RPC client/server transport, connection metadata, session turn/resource ownership, renderer requests, project and agent workflows, VS Code process/view/companion wiring, PTYs, Draw save conflicts, browser/CDP integration, rich-content protocols/capture, attachments, persistence, renderer bootstrap/observers, build configuration, and existing focused tests.

Baseline command:

```sh
pnpm test tests/app/services/pi/CakeSessionRuntimes.test.ts tests/app/services/renderer-requests/RendererRequestCoordinator.test.ts tests/app/main/MainApplication.test.ts tests/app/services/vscode/VsCodeServerRuntimeViews.test.ts tests/app/services/terminal/TerminalLive.test.ts tests/app/renderer/observers/observe-stream.test.ts
```

Result: **40 tests passed across 6 files**. These validate existing behavior, with external boundaries mocked; they are not proof of headless boot, network reconnection, or remote editor compatibility. The named cases above are proposed additions, not tests already implemented.

No runtime source was changed, no server was exposed, and no headless/remote UI experiment was run during this audit. The only repository deliverable is this proposal.
