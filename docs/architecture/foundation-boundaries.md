# Foundation process boundaries

This document is the compact process-safety contract. The complete runtime
design is in [`effect-architecture.md`](./effect-architecture.md).

| Process  | Owns                                                                                                                                                    | May import                                                                                                     | Must not expose                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Renderer | React, one window-local r-state-tree, one infrastructure Effect runtime, `RendererClient`, one Model synchronizer, renderer application state and logic | Renderer Models/Stores/components, renderer infrastructure, shared Effect RPC protocol, sandbox-safe libraries | Node globals, raw Electron IPC, raw Pi/Git/filesystem objects, main domain or Service implementations |
| Preload  | Frozen Electron transport for Effect RPC                                                                                                                | Electron IPC and shared transport Schemas                                                                      | `ipcRenderer`, arbitrary channels, business logic, privileged objects                                 |
| Main     | `MainLive`, Electron lifecycle, Effect RPC server, Cake domain operations, outside-world Services, persistence, scoped resources                        | Electron, Effect Platform, shared RPC protocol, Pi packages only through `src/services/pi`                     | Privileged or raw external objects crossing into preload/renderer                                     |

Cake is one logical application but not one in-memory Effect runtime. Main and
each renderer window have separate heaps, runtimes, Layers, Scopes, and Fibers.
Effect RPC connects them through shared Effect Schemas.

```text
renderer Store → RendererClient Promise adapter
→ CakeIpcClient → Effect RPC over preload/Electron transport
→ CakeIpcServer
→ Cake domain Effect operation
→ outside-world Services
```

Every request, success, typed failure, and streaming element is decoded at the
receiving boundary. Main rechecks trust, path, and permission policy; successful
renderer decoding is never privilege authorization.

The renderer never executes Cake domain modules. Renderer infrastructure calls
the grouped `CakeIpcClient`; the window-owned Model synchronizer consumes scoped
Streams, applies authoritative snapshots, and reduces subsequent Events
transactionally, using direct, batched mutations for incremental changes to
renderer-owned r-state-tree Models. Ordinary Stores use the
Promise-based `RendererClient`. RPC handlers are thin adapters to main domain
operations and contain no Cake business logic.

State and lifetime ownership:

- `RootStore` is the window composition and application-intent boundary, not an
  authoritative subscription or broad event-routing owner.
- Focused Stores own renderer workflows, local operations, and concurrency
  policy. Renderer bootstrap attaches the window-owned Model synchronizer and
  one-way Store snapshot persistence to the mounted Root Store; neither
  infrastructure owner participates in the Store tree.
- Effect Scope owns main resources, renderer connections, renderer-infrastructure
  subscriptions, and RPC cancellation. r-state-tree Store disposal owns local
  workflow cleanup and supplies abort signals to the client adapter.
- Pi owns Pi Session transcripts and runtime facts. Cake only projects them.
- Main persists Cake-owned facts through focused typed storage Services.
- Closing a renderer connection interrupts its RPC requests and subscriptions;
  it does not automatically destroy independently retained domain work.

Preload remains intentionally mechanical and exposes only the frozen Effect RPC
transport. Electron, filesystem, workspace, Managed Worktree, terminal, VS Code,
artifact, and widget commands use semantic grouped RPC operations with direct
payloads. Main implements those boundaries through focused Services; there is no
tagged command envelope or second main dispatcher. Non-authoritative native
lifecycle events use focused, renderer-connection-scoped application, artifact,
terminal, embedded-editor, and surface Streams. Adding a renderer capability means adding it to that shared
protocol and its focused main Service or domain boundary, never adding a generic
request envelope, ad hoc `window.cake` method, or Electron channel.
