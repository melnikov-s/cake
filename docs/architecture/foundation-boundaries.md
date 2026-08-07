# Foundation process boundaries

This document records the initial S0 runtime contract. It is intentionally
small and should evolve alongside the process-safe schemas in
`src/ipc`.

| Process | Owns | May import | Must not expose |
| --- | --- | --- | --- |
| Renderer | React presentation, the preload-to-intent adapter, and window-local `WindowStore` | Cake protocol types only at the adapter boundary; Cake state elsewhere | Node globals or raw Electron IPC |
| Preload | Validation and the frozen `window.cake` API | Electron IPC, Cake protocol schemas | `ipcRenderer` itself |
| Main | Window lifecycle, `DesktopKernelStore`, agent-process supervision and routing | Electron, Cake IPC contracts | Arbitrary project extension execution |
| Agent utility process | Pi runtime and extensions | Cake IPC contracts and, only through `src/agent/pi-runtime.ts`, Pi | Electron renderer/main privileges |

Every message is parsed with the shared Zod schemas at the receiving boundary.
The initial protocol starts a correlated Pi foundation operation, carries a
Pi-extension confirmation request and response, streams normalized text, and
observes agent-process state. Pi-specific event shapes are normalized inside
`src/agent/pi-runtime.ts`; they do not leak into the IPC contracts.

The renderer's `desktop-client.ts` is the transport boundary. It translates the
generic preload request/event bridge into `DesktopClient` intents and
application events. `WindowStore` depends only on that intent-level client and
does not import protocol schemas, construct IPC command discriminants, or
interpret transport response unions.

These are directories in one application package, not npm packages. The
boundaries exist because Electron builds and privileges the processes
differently; imports and validated IPC enforce them without a workspace layer.

State ownership in this slice:

- `DesktopKernelStore` is ephemeral main-process lifecycle state.
- `WindowStore` owns ephemeral renderer workflow state, the preload
  subscription, active operation identity, extension confirmation, and streamed
  text projection.
- Neither root is persisted yet.
- Both roots are created with `mount(createStore(...))` and disposed by their
  owning process lifecycle.

The exact Pi APIs covered by the S0 contract tests are recorded in
[`pi-0.84-contract.md`](./pi-0.84-contract.md).
