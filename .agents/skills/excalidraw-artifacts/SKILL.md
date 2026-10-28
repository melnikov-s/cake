---
name: excalidraw-artifacts
description: Create and collaboratively edit Excalidraw diagrams as interactive Cake artifacts. Use for hand-drawn architecture diagrams, editable whiteboards, flowcharts, and targeted changes to existing Excalidraw artifacts.
compatibility: Cake artifact widgets with dynamic widget packages and the artifact storage SDK.
---

# Excalidraw artifacts

Excalidraw is a widget library, not a Cake mode. Use generic artifact/state tools;
do not add Cake-specific shape operations. Keep one drawing for conversational
follow-ups, and change only the requested region.

## Choose the inexpensive path first

- **Show an existing drawing:** `artifacts.present` with its stable reference.
  This neither generates code nor changes the document.
- **Edit drawing content:** read `artifacts.state.read`, then use
  `artifacts.state.update` with the observed `expectedVersion`. No source revision,
  compilation, or model review is needed. Locate objects by ID after each read;
  preserve unrelated elements, bindings, files, selection, and metadata.
- **New drawing using an accepted editor:** `widgets.instantiate` with the
  linked editor's exact `@rN` reference, a new ID/title/fallback, and the complete
  new scene as `initialState`. It reuses retained code/assets, captures the new
  initial state, and stores an independent document. It does not copy the old
  drawing's live state. Read the editor's source only if its state format is unclear.
- **New editor behavior, or no reusable editor:** use `widgets.present` for new
  source, or `artifacts.replace` to revise existing source. These are programming
  workflows with compilation and visual review, not ordinary document edits.

Read [native scene conventions](references/scene.md) for construction or edits.
Read unfamiliar operation contracts with `<operation>.help`; broad `settings`
or `widgets` topic discovery is unnecessary when these commands are known.

For a label edit, set its native text object's `text` and `originalText` together.
The maintained editor template uses Excalidraw to wrap/recenter bound labels and
save the normalized geometry. Do not regenerate the editor for a label change.
Older published editors do not change when this skill changes: inspect their
source once if needed, and deliberately revise an old editor to adopt the template
before relying on its native layout normalization. A source seed is not live state.

## First editor setup

Check `settings.widgets.list` for `@excalidraw/excalidraw`. Only if missing and
user-authorized, install `@excalidraw/excalidraw@0.18.1` using
`settings.widgets.install` in Cake's widget package environment. Never install
into application/project dependencies, upgrade an installed library silently,
or rebuild/restart Cake for a widget dependency.

When generating an editor, give the generation branch the absolute path to
[assets/editor.tsx](assets/editor.tsx) and require it to read and reuse that file
and the scene reference. The caller does **not** need to load the full template
as well. Supply verified diagram facts, a small scene, and a readable fallback;
do not send a replacement React implementation as the presentation brief.

Keep rendering code separate from document data. New source still requires real
rendering and visual acceptance. Reuse existing accepted code for later drawings.

## Editor contract

- Set `window.EXCALIDRAW_ASSET_PATH` from the generic package-assets import
  **before** dynamically importing the native library. Retain local fonts/assets;
  never enable `unsafe-eval` or remote network access to suppress vendor warnings.
- Keep the template's fixed responsive container, hydration gate, native layout
  normalization, single-flight/debounce, acknowledgment and reconnect guards.
  Saved state wins over seeds. JSON-roundtrip both seeds and saved snapshots;
  converter output can contain own `undefined` properties.
- Persist native elements (including deletion tombstones), files, bindings,
  useful app-state settings, selection, and unrelated metadata—not runtime APIs,
  DOM nodes, Maps, or unfiltered appState. A failed save is not persistence.
- Native selection, drawing, pan/zoom, bound labels/arrows, frames, undo/redo,
  Mermaid insertion, import, Clear canvas, and PNG/SVG/`.excalidraw` exports remain
  the library's responsibility. Clear only on request. Native undo is editor-local.
- Use generic sandbox downloads and retained/data assets. Remote collaboration
  and network-dependent features are unavailable; report capability blockers.

## Verify without regenerating

Read back saved state after edits. Conflicts require rereading and reapplying the
intended delta, never retrying a stale whole scene. Present/reopen the same
artifact, not a new `widgets.present` result. Check actual live state when users
have edited the canvas: retained preview PNGs show only the original initial view.

An installed package or successful seeded preview does not prove live saving.
For editor changes, verify empty-storage initialization, text layout, preservation
of manual edits, save/reopen, and actionable save failures. Save before closing;
the 200 ms debounce and teardown flush cannot guarantee persistence after shutdown.

This is an ordinary distributable Pi skill. Its npm dependency is installed
separately in the widget environment; it does not change Cake's dependency graph.
