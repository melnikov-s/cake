# r-state-tree development inspection

Cake pins the published `r-state-tree@0.14.0`. Its Vite plugin requires Vite 8 (`parseSync`), so Cake uses Vite 8.3.4 with electron-vite 6.0.0; existing Oxlint 1.78.0 supports the shipped rules. Node 22.19+ is required. Cake handles compact Store snapshots at persistence/startup boundaries: empty state/children sections can be omitted, and an empty-root snapshot can be undefined. `scripts/vite-standard-decorators.ts` preserves esbuild lowering for development/SSR because Vite 8 only lowers standard decorators during production bundling; it runs after inspector metadata extraction. All five shipped syntax rules are enabled at error severity in `oxlint.config.ts`, used by `pnpm lint:oxlint` and `pnpm lint`. They have no autofixes. Mutable Store/Model collections are explicitly observable and keep their identity; copies are reserved for derived values and ownership/transport boundaries. Navigation uses scalar signatures for equality without captured-state writes, and keyed worker-chat owners keep unrelated workers' props stable without a mutating shared child-descriptor cache. The installed `node_modules/r-state-tree/lint/README.md` documents their analysis limits.

## Development launches

`pnpm dev`, `pnpm dev:agent`, and `pnpm dev:manual` automatically start the inspector relay through the renderer Vite plugin. Browser development (`pnpm exec vite --config vite.browser.config.ts`) has a separate relay. Both bind to loopback only; do not expose the dev server through a tunnel/proxy. Browser production sharing is unchanged and has no inspector.

The desktop record is `<checkout>/.r-state-tree-inspector.json`; browser development uses `<checkout>/.r-state-tree-browser-inspector.json`. Each managed worktree gets independent files. These owner-only (0600), gitignored records contain ephemeral credentials, not application state. Never print, copy into instructions, or commit their contents. Vite replaces the record on restart and removes it on orderly shutdown. Do not run two desktop dev servers in the same checkout simultaneously.

Registration is nonvisual and automatic for existing mounted roots:

| Renderer surface                                 | Registered roots                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Each local/remote desktop window                 | `DesktopConnection`, `RootStore`, `RootProjection`, `AppShell`                 |
| Drop-down Cake Chat window, when actually opened | Same roots, independent window/instance                                        |
| Screen capture overlay, when actually opened     | `ScreenCaptureOverlay`                                                         |
| Browser dev tab                                  | `BrowserConnection`, `BrowserMenus`, `RootStore`, `RootProjection`, `AppShell` |

Lazy children are never initialized for coverage. `AppShell` registers itself only when normal application consumers have realized and mounted it; this focused root keeps navigation state usable within the extension's bounded reads of Cake's much larger root. Inspect retained children through their owning root; `uninitialized` is intentional. Root Store disposal unregisters its roots; pagehide/HMR disconnects transports, unregisters all roots and disposes the inspector without disposing application state.

This is not whole-process observability. Electron main/preload, backend Effect services/Pi runtimes, server processes, workers, native helpers, webviews/iframes, and non-observable/React-local state are not registered. The RPC test harness has no application Store roots. Main-owned domain state is visible only through the renderer projection already delivered to that window. Maps/Sets and arbitrary class internals are unsupported. Bounded reads may truncate; getters/Context-only references are not exhaustive ownership discovery.

## Connect the actual Cake MCP host

Cake uses native Pi MCP configuration, with supported operations `settings.mcp.get` then `settings.mcp.update` (revision required). Project scope means the invoking Project Session's exact working directory, not any arbitrary checkout. Backend scope is shared and needs unique server names for each checkout/surface. Host registration is a separate authorized settings operation; this integration never writes settings files.

Use a stdio entry, not an HTTP endpoint:

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/checkout/node_modules/r-state-tree/dist/devtools-mcp.cjs"],
  "cwd": "/absolute/checkout",
  "env": {
    "RST_INSPECTOR_RELAY_FILE": "/absolute/checkout/.r-state-tree-inspector.json"
  },
  "description": "Read-only Cake development renderer Store/Model inspection",
  "exposure": "hidden",
  "toolExposure": {
    "rst_list_tabs": "codemode",
    "rst_list_roots": "codemode",
    "rst_inspect": "codemode",
    "rst_list_operations": "codemode"
  }
}
```

Resolve `node` on the actual backend host, or use its absolute Node executable. On the main workspace substitute `/Users/user/dev/cake`; for a managed worktree substitute that worktree's absolute path in **all three** locations. Use another named entry and the browser record path for browser dev. Do not reuse a main-workspace relay for another worktree. Explicit relay-file environment removes dependence on the renderer Vite root (`src/renderer` or `src/renderer/browser`). The installed `r-state-tree-inspector` executable is equivalent; its public entry is `dist/devtools-mcp.cjs`.

The host saves/reloads native configuration through `settings.mcp.update`; no manual setup is needed on each subsequent dev launch. Busy Project Sessions queue their resource reload until the current response settles, so their current tool registry is not evidence that registration failed. After settlement, use Pi's native `/mcp reconnect <server-name>` if needed and rediscover tools from a fresh response. The supported `settings.mcp.native` reconnect operation targets an idle Project Session; a running session can queue the native command between responses. No server discovery across arbitrary checkouts is promised. A closed window has no inspectable runtime. The MCP process rereads the record for each request and reconnects after Vite restarts.

The application sets `controls: false`: no field writes or method calls. The suggested host entry also hides explicit child initialization and Context evaluation, which can run application code even without controls. `rst_inspect` defaults to structure-only reads. Pass `evaluateComputeds: true` only when deliberate evaluation is authorized. Read-only is not a sandbox. Default credential-name redaction remains active; it is not data-flow tracking. Use synthetic development data.

Discover with `rst_list_tabs`, then `rst_list_roots({tabId})`. Select the actual window by title/origin and opaque IDs. Use bounded `rst_inspect({tabId,rootId,path:[],depth:1,maxEntries:100,evaluateComputeds:false})`, then a narrow literal path. Re-list IDs after reload/HMR; do not reuse old capabilities. For example, an already mounted desktop root exposes `["appShellStore","workspace"]`. Tool envelopes contain `value` or `error`; respect deferred, unsupported, redacted and truncated markers.

## Electron DevTools extension

Desktop development installs the package's unpacked MV3 extension through Electron's native `session.defaultSession.extensions.loadExtension` before opening the renderer, independently of the React DevTools install. Its path is resolved from the installed package, not a hard-coded worktree. No manifest patch, permission expansion, injected adapter, browser fallback, or relay credential is involved. Installation failures are logged by the existing developer-tools startup warning; they do not prevent Cake from opening.

Open Electron DevTools and choose **RStateTree** (possibly under overflow), select **AppShell**. Opening Settings and refreshing should change the `workspace` field from `cake-chat` to `settings`. Keep **Evaluate computeds** unchecked. This is manual refresh, not a subscription.

The loader is eliminated from production main bundles and refuses packaged apps. Packaging also excludes the optional inspector entry points/types and unpacked extension from the installed dependency; `tests/app/config/r-state-tree-production.test.ts` checks the installed file set against those filters without excluding core/React. Ordinary smoke launches skip extensions; the isolated development inspection test explicitly enables them with `CAKE_RST_DEVTOOLS_SMOKE=1`. The renderer's existing development-only registration serves the real panel without exposing main-process state.

```sh
pnpm test:electron:run tests/electron/r-state-tree-devtools.smoke.spec.ts
```

This exceptional test builds development main/preload output, starts loopback Vite, and creates hidden Cake/DevTools windows with empty temporary profiles. It checks the native installed extension, registered roots, read-only mode, a real Settings interaction and panel reread, and writes a screenshot to Playwright's output directory. Rebuild slim production output afterward before ordinary built-output smoke tests.

## Optional activity

Activity recording stays off by default because Cake retains large conversation projections and recording adds discovery, mutation and Promise-observation overhead. For a deliberate isolated diagnostic launch, use `VITE_CAKE_RST_ACTIVITY=1 pnpm dev`. History retains at most 200 records; all mutation values are withheld (`redactValues: () => true`). Call names/outcomes and field paths can still be sensitive. No latency/overhead benchmark or completeness guarantee is claimed. Closing DevTools does not stop MCP recording; teardown/unregister does.

Records cover observable action calls and successful writes on retained registered objects, grouped synchronously. They are not a complete reactive/async trace: no arguments/results/stacks, no invented attribution after `await`, no raw-source/unobservable writes, no replay/rollback. Inspect `discoveryTruncated`/`truncated`. Production builds exclude inspector transports and metadata; core library disabled debug branches are not a zero-overhead claim.

## Verification

```sh
pnpm test tests/app/config/r-state-tree-lint.test.ts
pnpm build:slim
pnpm build:browser
```

For runtime verification, use an isolated hidden Electron development instance with an empty profile and Cake's actual native MCP host. Synchronize the target checkout's installed dependencies with its pinned lockfile first; the configured command must exist in that checkout, not just another worktree. Check discovery and bounded state reads before/after a harmless navigation. Endpoint verification does not imply that the user's Cake host has been registered or attached. Do not inspect the user's running Cake.
