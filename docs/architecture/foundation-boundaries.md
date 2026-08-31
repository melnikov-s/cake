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
Streams, maps Updates to snapshots, and applies them to renderer-owned
r-state-tree Models. Ordinary Stores use the
Promise-based `RendererClient`. RPC handlers are thin adapters to main domain
operations and contain no Cake business logic.

State and lifetime ownership:

- `RootStore` owns window composition and event routing, not every workflow.
- Focused Stores own renderer workflows, local operations, and concurrency
  policy. Only `RootStore` supplies loaded Models to the window-owned Model
  synchronizer, which owns authoritative Stream subscriptions.
- Effect Scope owns main resources, renderer connections, renderer-infrastructure
  subscriptions, and RPC cancellation. r-state-tree Store disposal owns local
  workflow cleanup and supplies abort signals to the client adapter.
- Pi owns Pi Session transcripts and runtime facts. Cake only projects them.
- Main persists Cake-owned facts through focused typed storage Services.
- Closing a renderer connection interrupts its RPC requests and subscriptions;
  it does not automatically destroy independently retained domain work.

Preload remains intentionally mechanical. Adding a renderer capability means
adding it to the shared Effect RPC protocol and a privileged main handler, not
adding an ad hoc `window.cake` method.
