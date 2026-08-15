# Foundation process boundaries

This document records Cake's foundational runtime boundaries. It is
intentionally small and evolves alongside the process-safe schemas in `src/ipc`.

| Process | Owns | May import | Must not expose |
| --- | --- | --- | --- |
| Renderer | React presentation, the preload-to-intent adapter, and a window-local `RootStore` tree of focused behavioral Stores | Cake protocol types only at the adapter boundary; Cake state elsewhere | Node globals or raw Electron IPC |
| Preload | Validation and the frozen `window.cake` API | Electron IPC, Cake protocol schemas | `ipcRenderer` itself |
| Main | Window lifecycle, persistence, Pi workspace runtimes, native services, and routing | Electron, Cake IPC contracts, and Pi only through `src/agent/pi-runtime.ts` | Privileged objects or raw Pi objects crossing into preload/renderer |

Every message is parsed with the shared Zod schemas at the receiving boundary.
The protocol carries correlated Pi operations, Pi-extension UI requests and
responses, normalized session events, and application persistence operations.
Pi-specific event shapes are normalized inside
`src/agent/pi-runtime.ts`; they do not leak into the IPC contracts.

The renderer's `desktop-client.ts` is the transport boundary. It translates the
generic preload request/event bridge into `DesktopClient` intents and
application events. Renderer workflow Stores depend only on that intent-level
client and do not import protocol schemas, construct IPC command discriminants,
or interpret transport response unions.

These are directories in one application package, not npm packages. The
boundaries exist because Electron builds and privileges the processes
differently; imports and validated IPC enforce them without a workspace layer.

State ownership in this slice:

- `RootStore` owns the preload subscription and routes validated events. Focused
  child Stores own renderer workflows, operation identity, extension UI, and
  other behavioral surfaces. Sharing a window lifetime is not a reason to put
  unrelated state in one Store.
- Main-process lifecycle is ordinary Electron code. Introduce a
  main-process Store only when a concrete observable workflow benefits from
  Store state, derived values, effects, or composition.
- Main persists only Cake-owned application metadata. Pi remains authoritative
  for Pi sessions and transcripts.
- The renderer root is created with `mount(createStore(...))` and disposed by
  its owning process lifecycle.

The exact pinned Pi APIs covered by the adapter contract tests are recorded in
[`pi-0.84-contract.md`](./pi-0.84-contract.md).
