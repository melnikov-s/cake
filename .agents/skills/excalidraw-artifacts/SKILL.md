---
name: excalidraw-artifacts
description: Create and edit editable Excalidraw diagrams as Cake widgets, including adding shapes, labels, and connectors to existing drawings. Load for "create X diagram in Excalidraw", "draw in exilidraw" (common misspelling), architecture diagrams, flowcharts, and Excalidraw whiteboards. Create immediately using this skill's widget template; edit existing drawings through live state.
compatibility: Cake skill widget templates, the artifact SDK, and @excalidraw/excalidraw@0.18.1 added to the user's widget library environment.
---

# Excalidraw diagrams

## New drawing: load this skill, then create

Call the directly exposed `cake` tool with `widgets.instantiate` and
`template: "excalidraw-artifacts"`. This skill supplies the renderer through
`widget.json`; Cake prepares it internally when loading the session's skills.
The library is an ordinary user-added widget dependency, not part of Cake.
No previous artifact, editor reference or drawing is needed.

**Do not use codemode, search for artifacts/editors, discover settings/packages,
call help/schema discovery, read extra scene/template files, generate code, or
compile an editor to create an ordinary drawing.** Use the exact call below with
new diagram data and a unique ID. Do not route creation to `widgets.present`.

Hello World in a box (complete minimal call):

```json
{
  "command": "widgets.instantiate",
  "input": {
    "id": "hello-world-diagram",
    "title": "Hello World",
    "template": "excalidraw-artifacts",
    "initialState": {
      "skeleton": [
        {
          "id": "hello",
          "type": "rectangle",
          "x": 80,
          "y": 80,
          "width": 240,
          "height": 100,
          "label": { "text": "Hello World" }
        }
      ]
    },
    "fallback": { "markdown": "Hello World in a box." }
  }
}
```

Small actual diagram:

```json
{
  "command": "widgets.instantiate",
  "input": {
    "id": "client-api-diagram",
    "title": "Client and API",
    "template": "excalidraw-artifacts",
    "initialState": {
      "skeleton": [
        {
          "id": "client",
          "type": "rectangle",
          "x": 40,
          "y": 100,
          "width": 160,
          "height": 80,
          "label": { "text": "Client" }
        },
        {
          "id": "api",
          "type": "rectangle",
          "x": 340,
          "y": 100,
          "width": 160,
          "height": 80,
          "label": { "text": "API" }
        },
        {
          "id": "request",
          "type": "arrow",
          "x": 200,
          "y": 140,
          "points": [
            [0, 0],
            [140, 0]
          ],
          "start": { "id": "client" },
          "end": { "id": "api" },
          "label": { "text": "Request" }
        }
      ]
    },
    "fallback": { "markdown": "Client → API: Request." }
  }
}
```

## Essential scene conventions

- `initialState.skeleton` is native Excalidraw skeleton JSON, not source code or
  Mermaid. The skill's renderer uses the native library to supply defaults,
  editable text geometry and reciprocal bindings.
- Give shapes stable IDs, a native `type` (`rectangle`, `ellipse`, `diamond`,
  `text`, `arrow`, `line`, `frame`), `x`/`y`, and useful `width`/`height`.
  Shape `label: {"text":"…"}` becomes editable bound native text.
- Freestanding text uses `type: "text"` and `text: "…"`. Prefer short labels,
  font sizes 20–24, generous spacing, and a small readable initial view.
  Optional native styling includes `strokeColor`, `backgroundColor`,
  `fillStyle`, and `roughness`.
- Arrow `points` are relative to its `x`/`y`; use `start`/`end` with shape IDs
  for native bindings. Include all referenced shapes in the same call.
- Frame `children: ["child-id", …]` references elements included in the same
  conversion. Keep native frames and grouping distinct.
- Each creation call makes an independent drawing. For conversational
  follow-ups, edit the existing drawing instead of creating another one.

The result is already inline, expanded and editable. Do not add a redundant embed
or Open artifact link. The returned PNG shows only the initial state: it does
not verify live editing or saving. Respond briefly.

## Existing drawing: preserve live edits

Routine creation and edits are fully specified here. Do not look up API help,
search for another editor, read renderer source, or start code generation for
these recipes. Read `references/scene.md` only for advanced native scene work,
Mermaid, exports, or renderer changes not covered below. If a tool rejects the
contract, inspect that specific operation rather than guessing.

### Read → patch → read back

Use the artifact ID from this conversation or its displayed drawing. If no target
is known, use `artifacts.list` to identify it; ask only if the target is ambiguous.
Do not create another drawing for a follow-up such as “add something else.”

Read live state with this exact call (replace the placeholder):

```json
{
  "command": "artifacts.state.read",
  "input": { "lineageId": "<artifactId>" }
}
```

The response is `{lineageId, version, value}`. Use the **outer storage version**
as `expectedVersion`, not `value.version` (the Excalidraw file format), an element's
`version`, or the artifact source revision. `value` is the live native scene with
`type`, `version`, `source`, `elements`, `appState`, `files`, and `selection`.
If `skeleton` is still present, present the same drawing to let the editor
initialize, then reread before targeting native elements. Do not overwrite the
seed or convert the existing scene back into skeletons.

`artifacts.state.update` takes exactly `{lineageId, expectedVersion, edits}`.
Each edit is either `{"op":"set","path":"<JSON pointer>","value":...}` or
`{"op":"remove","path":"<JSON pointer>"}`. Parents must exist. Edits run in
order and save atomically; `set` at `/elements/-` appends one element. Multiple
appends belong in one call. JSON-pointer keys escape `~` as `~0` and `/` as `~1`.

Identify targets by stable element ID, then locate their array indices in the
fresh read. Never reuse indices from an old snapshot. Preserve unrelated IDs,
`containerId`, `boundElements`, bindings, files, deletion tombstones, selection,
viewport and metadata. On a version conflict, reread and reapply only the intended
delta; never retry a stale whole scene.

### Rename a label

Find the native text element, not its container. Change `text` and `originalText`
together. Keep the container relationship intact; the live renderer remeasures,
wraps and centers bound text, and saves its normalized geometry. Do not estimate
font metrics, rebuild the drawing, or add a skeleton `label` to a native shape.

Example (indices and version must come from the fresh read):

```json
{
  "command": "artifacts.state.update",
  "input": {
    "lineageId": "<artifactId>",
    "expectedVersion": 3,
    "edits": [
      { "op": "set", "path": "/elements/1/text", "value": "Updated label" },
      { "op": "set", "path": "/elements/1/originalText", "value": "Updated label" }
    ]
  }
}
```

### Add a shape and its editable label

Skeleton shorthand is for **new drawing initialization only**. After initialization,
append native elements to `/elements/-`; do not put `skeleton` back into state.
For ordinary additions, use the complete native rectangle/ellipse/diamond and
text recipe below. No library import or renderer revision is needed.

Before sending:

- Choose IDs unused by **all** current elements, including deleted ones.
- Choose an empty area from current bounds; leave about 40–80 units between nodes.
  Bounds use scene coordinates, not screen pixels. Do not reset pan/zoom.
- Replace `expectedVersion` with the read's outer version. Use fresh integer seeds
  and nonces, and a current Unix-millisecond `updated` timestamp for new elements.
- Set ordering `index` to `null` for new elements, letting the native editor assign
  fractional indices in appended array order; do not guess the next index string.
- Keep the reciprocal relationship: the shape's `boundElements` references the
  label, and the text's `containerId` references the shape. Use a single update.
- Text geometry below is an initial estimate. The mounted renderer uses the native
  library to measure/wrap/recenter it. Ellipses and diamonds have less usable text
  space than rectangles: use short labels or larger shapes.

Complete example: append a blue oval below the original Hello World rectangle.
Replace placeholder IDs/version/timestamps as above; retain all other scene data.

```json
{
  "command": "artifacts.state.update",
  "input": {
    "lineageId": "<artifactId>",
    "expectedVersion": 3,
    "edits": [
      {
        "op": "set",
        "path": "/elements/-",
        "value": {
          "id": "greeting-oval",
          "type": "ellipse",
          "x": 80,
          "y": 240,
          "width": 280,
          "height": 120,
          "angle": 0,
          "strokeColor": "#1971c2",
          "backgroundColor": "#d0ebff",
          "fillStyle": "solid",
          "strokeWidth": 2,
          "strokeStyle": "solid",
          "roughness": 1,
          "opacity": 100,
          "groupIds": [],
          "frameId": null,
          "index": null,
          "roundness": null,
          "seed": 246810,
          "version": 1,
          "versionNonce": 135791,
          "isDeleted": false,
          "boundElements": [{ "type": "text", "id": "greeting-label" }],
          "updated": 1793162185000,
          "link": null,
          "locked": false
        }
      },
      {
        "op": "set",
        "path": "/elements/-",
        "value": {
          "id": "greeting-label",
          "type": "text",
          "x": 130,
          "y": 287.5,
          "width": 180,
          "height": 25,
          "angle": 0,
          "strokeColor": "#1971c2",
          "backgroundColor": "transparent",
          "fillStyle": "solid",
          "strokeWidth": 2,
          "strokeStyle": "solid",
          "roughness": 1,
          "opacity": 100,
          "groupIds": [],
          "frameId": null,
          "index": null,
          "roundness": null,
          "seed": 246811,
          "version": 1,
          "versionNonce": 135792,
          "isDeleted": false,
          "boundElements": [],
          "updated": 1793162185000,
          "link": null,
          "locked": false,
          "text": "nice to meet you",
          "fontSize": 20,
          "fontFamily": 5,
          "textAlign": "center",
          "verticalAlign": "middle",
          "containerId": "greeting-oval",
          "originalText": "nice to meet you",
          "autoResize": true,
          "lineHeight": 1.25
        }
      }
    ]
  }
}
```

For a rectangle or diamond, change the shape `type` and choose suitable bounds.
For a shape without a label, omit the text append and use `boundElements: []`.
For freestanding text, append only the text object with `containerId: null`,
`textAlign: "left"`, `verticalAlign: "top"` and the desired position. Set both
`text` and `originalText`. Font families: `5` is Excalidraw's hand-drawn font,
`1` is Virgil, `2` is Helvetica, `3` is Cascadia. Prefer the template's default `5`.

### Add a straight bound arrow to existing nodes

For simple connectors, construct a complete native arrow with the same common
fields as the shape above (`angle`, styling, opacity, groups, frame, index, seed,
version/nonce, deletion flag, timestamp, link, lock). Change `type` to `"arrow"`,
use `backgroundColor: "transparent"`, `boundElements: []`, and
`roundness: {"type": 2}`. Replace its geometry with these **native** fields:

```json
{
  "id": "new-connector",
  "type": "arrow",
  "x": 321,
  "y": 130,
  "width": 138,
  "height": 0,
  "points": [
    [0, 0],
    [138, 0]
  ],
  "lastCommittedPoint": null,
  "startBinding": { "elementId": "left-node", "focus": 0, "gap": 1, "fixedPoint": null },
  "endBinding": { "elementId": "right-node", "focus": 0, "gap": 1, "fixedPoint": null },
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "elbowed": false
}
```

This geometry assumes the left node's right edge is at `(320, 130)` and the
right node's left edge is at `(460, 130)`. Adapt to the freshly read node bounds:
`x`/`y` are the arrow's origin, `points` are offsets from that origin, and
`width`/`height` are the point bounds. `focus: 0` means a centered attachment;
`gap: 1` leaves one scene unit from the shape edge. Do not copy these coordinates
onto differently placed nodes. Use native routing for complex/elbowed arrows.

Append the full arrow object and add `{"type":"arrow","id":"new-connector"}`
to **each** endpoint node's `boundElements` in the same `artifacts.state.update`.
For an existing array append at `/elements/<fresh node index>/boundElements/-`.
If `boundElements` is null/missing, set that field to an array containing the new
reference instead. Preserve existing text and arrow references. Native text
labels on arrows follow the same reciprocal container/label recipe as shapes;
let the renderer position the text. Unbound arrows use null endpoint bindings,
but must not be described as attached connectors.

### Other common edits

- **Style:** patch only the requested fields, e.g. `/elements/0/backgroundColor`,
  `/elements/0/strokeColor`, `/elements/0/fillStyle`, `/elements/0/roughness`.
  Fill styles are `solid`, `hachure`, or `cross-hatch`. Shape and label colors are
  separate. Keep text readable against the fill.
- **Move/resize:** patch `x`, `y`, `width`, `height` on simple unconnected shapes;
  the renderer repositions bound text. For connected shapes, groups, frames, or
  routed arrows, use native editor actions when available: changing node coordinates
  alone does not reroute its arrows. Do not claim a move is complete if bindings
  or endpoints remain wrong.
- **Connect nodes:** use the skeleton example for a new scene or the native arrow
  recipe above for an existing scene. Skeleton `start`/`end` and `label` are not
  native fields. Never rebuild an existing scene to add one connector. For a plain
  line, use native `type: "line"`, common fields, `points`,
  `lastCommittedPoint: null`, and null arrowheads; omit arrow-only bindings and
  `elbowed`.
- **Delete:** use native deletion semantics (`isDeleted: true`), not removal from
  the array. Include a deleted shape's bound label and repair surviving reciprocal
  references/connector bindings. Never delete connected objects by blindly removing
  one array item. Only clear the canvas on explicit request.
- **Metadata:** for non-text native element changes, increment the affected
  element's native `version`, refresh `versionNonce` and `updated` in the same
  patch. Keep `id` and `seed`. The renderer handles text-layout version bumps;
  storage `expectedVersion` remains a separate number.

### Confirm and show the same drawing

After each update, call `artifacts.state.read` again and check the requested
objects/fields. The editor may save normalization as another storage version;
that is expected. A saved patch is not evidence of interactive rendering.
Show/reopen the same drawing with this complete call:

```json
{
  "command": "artifacts.present",
  "input": { "reference": "cake://artifact/<artifactId>" }
}
```

Do not regenerate source for ordinary content edits. A source revision or retained
PNG can stay unchanged while live drawing state changes; do not use the initial
preview as proof of the updated drawing. Confirm visual layout only when you have
actually inspected current rendered pixels. Report storage/rendering failures
honestly. Respond briefly with what was added/changed, without a redundant link.
Native selection, drawing, pan/zoom, undo/redo, import and export remain the
library's responsibility.

Edits save automatically without routine status UI. If saving fails, use Retry
saving drawing; report unresolved failures. Before closing, confirm the latest
edits with `artifacts.state.read`. Native undo history belongs to the current
editor; the saved drawing survives reopening. For interactive verification, edit
the native canvas, confirm autosaved state, and reopen it; stored state alone does
not prove that workflow.

## Installation and renderer changes (not ordinary creation)

Add this portable Pi skill and add `@excalidraw/excalidraw@0.18.1` to Cake's widget
library environment once with user authorization. Start a fresh session after
adding the skill/library. A preparation error is a setup blocker, not a reason to
search for an old editor, silently install packages, or generate replacement code.
Do not install this library into Cake's application/project dependencies.

`assets/editor.tsx` is skill-owned reusable code, separate from all document data.
`widget.json` opts it into Cake's generic widget-template preparation. Other
skills/libraries can use the same mechanism; Cake knows no Excalidraw operations
or scene types. Renderer changes need real rendering and interaction verification;
ordinary new diagrams only supply JSON state. Template changes apply after skill
preparation to newly instantiated drawings, not already accepted widgets. Existing
widgets retain their published browser output until an explicit source revision;
do not replace their source or drawing state without authorization.

Keep local fonts/resources, hydration, JSON normalization, native text layout,
single-flight/debounce, save acknowledgment and reconnect behavior. Never enable
unsafe-eval, remote network access or parent access. Native remote collaboration
and network-dependent features are unavailable; report those limits.
