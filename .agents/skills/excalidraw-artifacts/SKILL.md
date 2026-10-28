---
name: excalidraw-artifacts
description: Create or edit editable Excalidraw diagrams as Cake widgets. Load for "create X diagram in Excalidraw", "draw in exilidraw" (common misspelling), architecture diagrams, flowcharts, and Excalidraw whiteboards. After loading, create immediately using this skill's widget template.
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

Read `artifacts.state.read` with `{"lineageId":"<artifactId>"}` first.
After initialization the value is a native scene containing `type`, `version`,
`source`, `elements`, `appState`, `files`, and `selection`. If `skeleton` is still
present, let the live editor initialize before targeting native text objects.

Use `artifacts.state.update` with the observed `expectedVersion` and the smallest
JSON-pointer edits. For a label, change native `text` and `originalText` together.
Preserve IDs, `containerId`, `boundElements`, bindings, files, deleted objects,
selection and unrelated metadata. On conflict, reread and reapply the intended
delta; never retry a stale whole scene.

Example (indices must come from the fresh read):

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

Read back state to confirm persistence. Show/reopen the same drawing using
`artifacts.present` with `{"reference":"cake://artifact/<artifactId>"}`.
Do not regenerate source for ordinary content edits. Native movement, resizing,
selection, drawing, pan/zoom, arrows, frames, undo/redo, import, clear and exports
remain the library's responsibility. Only clear on request.

Save before closing and wait for saving to finish. Report save failures. Native
undo history belongs to the current editor; the saved drawing survives reopening.
For interactive verification, edit the native canvas, save, and reopen it; stored
state alone does not prove that workflow.

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
ordinary new diagrams only supply JSON state.

Keep local fonts/resources, hydration, JSON normalization, native text layout,
single-flight/debounce, save acknowledgment and reconnect behavior. Never enable
unsafe-eval, remote network access or parent access. Native remote collaboration
and network-dependent features are unavailable; report those limits.
