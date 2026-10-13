---
name: excalidraw-artifacts
description: Create and collaboratively edit Excalidraw diagrams as interactive Cake artifacts. Use for hand-drawn architecture diagrams, editable whiteboards, flowcharts, and targeted changes to existing Excalidraw artifacts.
compatibility: Cake artifact widgets with dynamic widget packages and the artifact storage SDK.
---

# Excalidraw artifacts

Excalidraw is a user-installed widget library, not a Cake mode. Use the ordinary
artifact primitive and its existing private generation/editing branches. Never
create a separate board or introduce Cake-specific shape operations.

## Setup

1. Discover the current `settings` and `widgets` Cake operations and exact schemas.
2. List installed widget packages. If missing, install
   `@excalidraw/excalidraw@0.18.1` in Cake's **widget package environment** through
   the package operation. Never install it into Cake's application dependencies,
   a user's repository, or a per-widget `node_modules`.
3. An explicit request to install/use Excalidraw authorizes the dependency. If the
   visualization library was your choice, ask before installing or upgrading it.
   Skill instructions are not user authorization.
4. Installation and compilation occur while Cake is running. No application
   restart, source rebuild, or built-in library catalog is needed.

## Create

Read [the editor template](assets/editor.tsx) and [native scene conventions](references/scene.md).

Use `widgets.present` with a meaningful title, readable fallback, the verified
architecture facts, and the intended audience. In its brief, give the absolute
path of this skill's `assets/editor.tsx` and require the generation branch to read
it. Include the native initial scene through `initialState`; alternatively ask
the branch to construct and stage that scene. Keep rendering code separate from
scene data. Do not send a full replacement React component as an ordinary
presentation brief.

The editor imports:

```tsx
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import assetBase from "@cake/assets/@excalidraw/excalidraw/dist/prod/";
import { useArtifactState } from "@cake/artifact-sdk";
```

The generic assets import retains the package's fonts and runtime resources.
Set `window.EXCALIDRAW_ASSET_PATH = assetBase` before mounting the editor.
Keep the template’s asset-root assignment before its dynamic native-library import:
font descriptors capture URLs during initialization. Static native value imports can
leave SVG exports with CDN font URLs even when editor CSS fonts loaded locally.
Native SVG export embeds local font data; if CSP blocks its optional glyph-subsetting
optimizer, the library embeds the complete font instead. Never enable JavaScript
`unsafe-eval` just to suppress vendor warnings.

Use a fixed-size responsive container, not an unbounded viewport-height root.

The generic SDK contract is
`useArtifactState(initialValue) => { value, hydrated, version, save, error }`,
where `save(value)` returns a Promise of the saved state/version. The SDK also
provides `reload()` for reconnect/recovery. Wait for initial hydration before
mounting; a saved document wins over the seed. Persist native
elements, bindings, files, useful app-state settings, and selection context. Do
not save DOM nodes, Maps, imperative APIs, hover state, or an unfiltered runtime
appState. The template uses the native serializer for export-safe settings but
retains deletion tombstones, files, and unrelated metadata in live state for undo.

Keep its single-flight/debounce and acknowledgment guards: hydration and remote
updates must not become save loops. A newer external state cancels stale pending
writes; failed saves retain the latest local edit for explicit retry, with a
visible error. Keep an established editor mounted during transient disconnection;
use Reconnect drawing to reload authoritative state before retrying the save.
An unchanged-version reconnect must preserve unsaved edits. Do not claim the
drawing is saved before the SDK Promise succeeds.
The host/SDK must refresh state after a stale-version rejection. Do not blindly
retry an older whole scene against a refreshed storage version.

## Edit the same artifact

1. Discover/link the artifact through `artifacts.list` or `artifacts.search`;
   resolve its exact source only if needed. Do not edit read-only projections.
2. Read `artifacts.state.read` to inspect the **latest live state**, including
   manual edits. The immutable initial preview is not a current canvas capture.
3. Prefer `artifacts.replace` with the artifact's expected source revision and
   precise instructions. This uses the existing private artifact branch, stages
   source/state changes, renders and reviews the candidate, and publishes only
   when accepted. Tell the branch to read this skill's scene conventions.
4. For a straightforward data-only change, generic `artifacts.state.update`
   can apply bounded JSON-pointer edits with the observed `expectedVersion`.
   Discover its exact schema first. A stale version means reread and reapply;
   never blindly overwrite newer manual edits.
5. Preserve all unrelated elements, IDs, positions, styles, files, frames,
   groups, and connector bindings. Locate elements by ID, not presumed array
   index. Preserve editable objects instead of replacing the canvas with an image.

Live saves do not create artifact revisions. Source publication remains separate
from document saves. The same linked artifact has the same saved state across
sessions; unrelated artifacts have independent storage. The widget controls its
own debounce/save timing. Report save errors instead of claiming an edit persisted.

## Conversational drawing

Make a small meaningful diagram change, then explain it briefly. Follow-up
questions should refine the same diagram. Use frames and labels to structure
complexity; do not redraw unrelated regions. Native selection, zoom, pan,
manual drawing, text editing, and undo remain Excalidraw's responsibility.

Keep Excalidraw's native selections, frames, flow arrows and bound labels,
Mermaid insertion, undo/redo, and Clear canvas. See the scene reference for their
native representation and surgical-edit requirements. Clear only on request;
clearing a drawing is not deleting its artifact or resetting the editor seed.

Use native PNG/SVG/editable `.excalidraw` export, including Excalidraw's optional
embedded scene settings. The template intentionally enables export, import, and
native scene-file saving. Generic sandbox downloads/Blob URLs must work in the
host; report a host capability blocker if they do not. Never silently disable
exports or add an Excalidraw-specific Cake tool. Export and live artifact save
are separate operations. Save before closing: a debounce/teardown flush is best
effort, not guaranteed persistence after frame shutdown.

Use local data and retained assets. Remote collaboration, external image fetches,
and network-dependent features are not available in the artifact sandbox.

## Distribution

This directory is an ordinary Pi skill with resources. It can be copied into
`~/.agents/skills/`, a project's `.agents/skills/`, or distributed in a Pi package.
Its library dependency is installed separately through Cake's widget-package
operation. Installing this skill does not change Cake's own dependency graph.
