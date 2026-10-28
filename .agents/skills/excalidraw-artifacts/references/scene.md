# Native Excalidraw scene edits (0.18.1)

Use Excalidraw's native scene JSON as the artifact state, not a Cake drawing
protocol. The editor seed is only a starting value. Always inspect the latest
`artifacts.state.read` before an edit; manual edits and selection are live state.
Ordinary creation is fully documented in SKILL.md: use the skill widget template
and skeleton initialState directly. This reference is for advanced scene/editor work.

## Document shape

```ts
{
  type: "excalidraw",
  version: 2,             // Excalidraw file format, NOT the storage CAS version
  source: "artifact",
  elements: [...],        // native editable objects, including deletion tombstones
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20, gridModeEnabled: false, ... },
  files: { ... },         // native file IDs -> binary-file records with dataURL
  selection: { "node-id": true } // template's saved selectedElementIds context
}
```

The SDK `version` is the separate storage compare-and-swap version. Source
revision, scene format version, native element version, and storage version are
not interchangeable.

Keep unknown document fields and element `customData`. Preserve element IDs,
`seed`, native `version`/`versionNonce`, fractional ordering `index`, `groupIds`,
`frameId`, `boundElements`, text `containerId`, connector bindings and files
unless the requested edit specifically changes them. Excalidraw's file-export
serializer drops deleted elements and unused files; the template deliberately
retains those in live storage so native undo has its data. Do not serialize the
entire runtime appState: collaborators, Maps, file handles, APIs, DOM references,
hover/drag/edit state and viewport dimensions do not belong in storage.

## Construct new elements with the library

For new shapes use `convertToExcalidrawElements`, not hand-written partial
native objects. Explicit stable IDs help later surgical edits:

```tsx
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

const elements = convertToExcalidrawElements(
  [
    {
      id: "client",
      type: "rectangle",
      x: 60,
      y: 80,
      width: 180,
      height: 80,
      label: { text: "Client" },
    },
    {
      id: "service",
      type: "rectangle",
      x: 360,
      y: 80,
      width: 180,
      height: 80,
      label: { text: "Service" },
    },
    {
      id: "request",
      type: "arrow",
      x: 240,
      y: 120,
      points: [
        [0, 0],
        [120, 0],
      ],
      start: { id: "client" },
      end: { id: "service" },
      label: { text: "Request" },
    },
  ],
  { regenerateIds: false },
);
```

Before using converter output as an initial seed or staged state, JSON-roundtrip
the complete selected persistent scene: `JSON.parse(JSON.stringify(scene))`.
Native elements may have own `customData: undefined`; postMessage does not remove
it. Apply the same normalization to every save, preserving JSON metadata, deletion
tombstones and files. The native export serializer alone drops undo data.

The converter creates native defaults and reciprocal container/text/arrow
bindings. Verify the resulting IDs, text bounds, arrows, and ordering; the
converter may create additional bound label objects. Do not pass an entire
existing drawing through a skeleton converter to make one small edit.

## Surgical edits

1. Read current state and its storage version. Identify target IDs by label,
   selection, frame membership, or explicit user reference. Ask when ambiguous.
2. Map IDs to their current array positions only after this read. A JSON-pointer
   index is a location in this exact snapshot, never a persistent identity.
3. Modify the smallest region. Preserve all unrelated objects verbatim, including
   intentionally deleted tombstones. `newElementWith(element, updates)` is the
   library helper for updating an existing element and bumping its native
   version, nonce and timestamp without changing its ID.
4. For document edits use bounded `artifacts.state.update` with the observed
   `expectedVersion`, including label/content changes. Keep native geometry and
   reciprocal bindings consistent when changing structure. Use `artifacts.replace`
   for editor source/behavior changes, not as the default document-editing path.
   Complex geometric edits should use native editor actions when available;
   don't launch a programming workflow just to rename a label.
5. On a version conflict reread, relocate the IDs, and reapply the intended delta.
   Never retry a stale full-scene overwrite against a newer version.
6. Read back accepted state and inspect the rendered candidate. Do not claim a
   persisted change on an SDK/storage error or from a preview alone.

For a label edit, update `text` and `originalText` together on the native text
object using a state update. The maintained editor template restores elements
with native binding repair and text-dimension refresh, bumps changed text versions,
and saves normalized wrapping/container placement. The agent need not calculate
font metrics or regenerate source. Leave `containerId` and the parent's
`boundElements` entry intact. Existing immutable editor implementations need a
one-time source revision to adopt this behavior; editing a skill file does not
patch already-published browser output. Connector endpoint geometry is relative to the connector's
`x`/`y`; moving a node requires native binding recalculation, not just changing
an arrow's global coordinates. Removing a node requires repairing reciprocal
bindings and attached labels. Prefer native editor actions for complex movement,
resizing, grouping, frame wrapping, and elbow-arrow routing.

## Selection, frames, and flow diagrams

- `selection` maps selected element IDs to `true`. It is useful context, not an
  instruction to modify everything selected. Group context is retained in
  `appState.selectedGroupIds` and `editingGroupId`. Do not replace unrelated
  selection or navigation state during an unconnected edit.
- `groupIds` represents groups; it is not a replacement for `frameId`.
- A native frame is an editable frame element with its own ID and name; children
  reference it via `frameId`. The skeleton converter also accepts a frame with
  `children: [existingChildId, ...]`. Include the referenced children in the same
  conversion input when creating a new scene, and use native Wrap selection in
  frame for live manual edits. Keep frame bounds and clipping intentional.
- Use frames for regions or steps, bound text for labels, and native bound arrows
  for flow direction. Keep diagrams small enough to read at the initial zoom;
  do not sacrifice editable relationships for a rasterized flowchart.
- For another independent drawing, use `widgets.instantiate` with
  `template: "excalidraw-artifacts"` and a new skeleton or native scene as
  `initialState`. This skill supplies the renderer; no prior artifact/editor link
  is needed. For a follow-up, edit the existing lineage instead.
- Excalidraw supplies selection, text entry, pan/zoom, free draw, shapes, arrows,
  grouping, frame tools, keyboard shortcuts, undo/redo, and Clear canvas. Keep
  these native controls available; do not recreate them as Cake operations.

## Mermaid

The installed Excalidraw package includes its Mermaid-to-Excalidraw dependency
and native Mermaid insertion UI. Prefer that native action for manual insertion
or paste supported Mermaid syntax. For an agent-generated conversion, use the
installed converter's actual exported API in the private generation branch,
then `convertToExcalidrawElements` on its returned skeleton and retain any returned
files. Inspect support and the rendered result: supported flows should become
editable objects; some unsupported diagram types may produce image output.
Do not claim arbitrary Mermaid diagrams become native editable shapes.

When adding a Mermaid flow to an existing scene, offset only the new objects,
choose noncolliding IDs, preserve their internal bindings, append them in correct
order, and leave the old objects untouched. Never replace an existing frame with
a new whole-canvas conversion to change one node. No Mermaid-specific Cake tool
or application dependency is required; additional directly imported packages
must be installed with user authorization in the widget package environment.

## Undo, clearing, and export

The template applies accepted external updates with native
`CaptureUpdateAction.IMMEDIATELY`, without remounting or clearing native history.
User undo/redo produces ordinary live saves. Native undo is editor-local, not a
second persistent artifact revision history; after reopening, saved state is
restored but the old native undo stack is not.

Only clear when the user asks. Use native Clear canvas for manual clearing; an
agent clear should be an explicit staged state edit, preserving unrelated document
metadata and using native deletion semantics where undo is intended. Deleting the
artifact is not the same as clearing its drawing. Do not reset the initial seed
or remove the artifact link to clear a saved canvas.

Use native Excalidraw export for PNG, SVG, and editable `.excalidraw` files. The
template provides Export PNG / Export SVG / Export drawing controls using native
`exportToBlob`, `exportToSvg`, and `serializeAsJSON`, plus a generic Blob download.
Native menu export remains enabled. PNG and SVG may optionally embed the editable
scene through Excalidraw's export settings. Exporting a file is not an artifact save and does not publish a source
revision. The host must support generic sandbox file downloads/Blob URLs; if it
does not, report the capability blocker rather than hiding export or inventing a
library-specific Cake tool. Images must use retained local/data assets, not remote
fetches; font resources come from the template's `@cake/assets/…` import.

## Save behavior and review checklist

The template waits for SDK hydration, normalizes external-update echoes, debounces
changes, and runs one save at a time. It distinguishes its own acknowledgment
from a newer external version. A newer external state cancels pending stale
writes and is shown with a notice; a storage/network failure keeps the latest
local snapshot for explicit retry. The native editor stays mounted through a
transient disconnect, and the generic SDK `reload()` backs Reconnect drawing.
Reloading an unchanged version preserves unsaved edits; loading a newer version
follows the external-update path. The SDK save closure binds its rendered storage
version and refreshes authoritative state on rejection before another save can be
allowed. Do not remove those guards when adapting the template.

Check loading/error state, drag/text edits, repeated save acknowledgments, edits
during a save, failed-save retry, disconnect/reconnect with an unchanged or newer
version, external edits during a pending/in-flight save, cross-instance scene synchronization, selection, bound arrows/labels, frames, undo/redo, clear, fonts, and each export
format. Save before closing if persistence is important: the 200 ms debounce and
best-effort close flush cannot guarantee a reply after frame/application teardown.
