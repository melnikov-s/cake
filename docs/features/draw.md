# Draw behavior and persistence

Draw embeds Excalidraw as an editor, not another runtime or conversation. Main owns
saved boards and Session association; Excalidraw owns the editable shape graph.
`DrawStore` owns board selection, remembered active board, readiness, playback, and
serialized autosave. `DrawControlStore` dispatches controls for loaded Sessions,
including background Sessions, without changing shell selection.

## Authoring and geometry

`cake draw` uses the existing renderer-request coordinator. Topic discovery is
compact; `<command>.help` reveals one exact Schema. See
[compact authoring](../development/draw-authoring.md) for flow/frame examples.

`draw.flow`/`draw.frame` translate into validated Apply, not another transport.
The adapter measures only new nodes, uses native bound arrows and `frameId`, and
places new stages past collisions without relayout of existing content. Frames fit
once, cannot nest, and are not future layout constraints. Flows plan once and
reveal nodes followed by connections within the bounded playback duration.

`draw.mermaid` is the complete structured-diagram boundary. A named conversion
atomically creates/replaces a stable region, preserves unrelated art, and persists
native editable elements tagged with diagram/semantic identities. Public shape IDs
use `shape:<id>` and receipts return semantic mappings. The converter owns Mermaid
geometry/text: Cake does not refit text, reflow siblings/subgraphs, reposition
labels, or spread parallel edges. It validates editability, remaps identities,
translates the whole diagram away from artwork, and fits the camera. Lossy image
kinds reject; no second graph or diagram language is persisted.

Manual semantic edits preserve IDs while changing validated geometry, text, style,
locking, selection, alignment/distribution/layers, connector ports/routing, and
source links. Bound connectors reroute after node geometry changes. Raw elements,
arbitrary patches/hyperlinks, freehand arrays, and unbounded batches never cross
the control boundary.

## Playback, viewport, and checkpoints

Batches validate before mutation and play operation by operation with active-shape
focus and cumulative framing, then persist once. Intermediate autosaves and pointer
edits are suppressed; final flush precedes success. Each structural operation is
one playback stage, with no extra durable layout state.

Automatic framing fits live changed elements, bound labels, and connector endpoints
at at most 100% zoom, not unrelated art or only the final operation. Explicit
`zoom-to` wins; style-only batches preserve camera. Camera commits precede receipt
and saved snapshot. Receipts return composition bounds and compact shape layout,
including endpoints, without echoing the full scene. Reads return viewport,
selection, bounds, and compact styles for relative placement.

Viewport reads/renders use actual pane offsets, scene rectangle, zoom, and theme,
including blank space. Page/selection renders are content-fitted exports, not
viewport proof. Rendering downscales to a validated maximum; camera fitting includes
labels/padding. Saved boards restore actual scroll/zoom.

Each successful agent mutation records a bounded renderer-owned pre-mutation
checkpoint. `draw.undo` restores it atomically during mounted-board lifetime only.
Checkpoints are neither durable history nor a replacement for Excalidraw user undo.

## Links, autosave, and export

Source links contain Working Directory-relative paths/ranges behind Cake's reserved
Draw URL. Renderer activation uses embedded-editor reveal. Ordinary Excalidraw
links retain safe handling. Drawing gestures persist but never start Pi turns.
Boards autosave independently of artifact publication.

Cake hides the generic Excalidraw menu and exposes PNG, SVG, and native `.excalidraw`
exports. Interactive export uses the owning window's save dialog and main filesystem;
`draw.export` writes to an explicit workspace-relative path. Both serialize a copy
without changing active board or persistence binding.

## Verification

- [Draw workflow](../../tests/app/renderer/draw-workflow.test.tsx)
- [Canvas regions](../../tests/app/renderer/draw-canvas-region.test.tsx)
- [Export toolbar](../../tests/app/renderer/draw-board-toolbar.test.tsx)
- [Agent operations](../../tests/app/agent/cake-draw-operations.test.ts)
- [Board storage](../../tests/app/domain/drawBoards.test.ts)
- [Source links](../../tests/app/domain/draw-source-link.test.ts)
