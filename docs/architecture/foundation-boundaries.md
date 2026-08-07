# Foundation process boundaries

This document records the initial S0 runtime contract. It is intentionally
small and should evolve alongside the process-safe schemas in
`packages/protocol`.

| Process | Owns | May import | Must not expose |
| --- | --- | --- | --- |
| Renderer | React presentation and window-local `WindowStore` | Cake protocol types, Cake state | Node globals or raw Electron IPC |
| Preload | Validation and the frozen `window.cake` API | Electron IPC, Cake protocol schemas | `ipcRenderer` itself |
| Main | Window lifecycle, `DesktopKernelStore`, worker supervision and routing | Electron, Cake protocol/state | Arbitrary project extension execution |
| Utility worker | Future Pi runtime and extensions | Cake protocol and, through `packages/pi-runtime`, Pi | Electron renderer/main privileges |

Every message is parsed with the shared Zod schemas at the receiving boundary.
The initial protocol is deliberately limited to starting a deterministic worker
stream and observing worker state. Pi-specific event shapes will be normalized
inside `packages/pi-runtime`; they must not leak into this protocol.

State ownership in this slice:

- `DesktopKernelStore` is ephemeral main-process lifecycle state.
- `WindowStore` is ephemeral renderer lifecycle state.
- Neither root is persisted yet.
- Both roots are created with `mount(createStore(...))` and disposed by their
  owning process lifecycle.
