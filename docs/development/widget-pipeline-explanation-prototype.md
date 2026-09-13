# Widget publication paths — React Flow authoring handoff

## Status: authored, blocked on integrated compiler

The redirected prototype imports real `@xyflow/react` inside an ordinary React widget artifact. It does **not** introduce another artifact type, graph DSL, renderer canvas, or generator. The first request explanation stays intact. The existing widget compiler in this checkout rejects that import; compiler/CSS integration belongs to the parallel integration assignment. No dependencies, compiler policy, CSP, or host feature components were changed here.

**Do not treat this handoff as visual or interaction acceptance.** The final React Flow composition has not rendered successfully in this checkout. Both new Electron cases time out before the widget heading appears. The current compiler's explicit allowlist permits only React/approved D3 and rejects `@xyflow/react`. Build/typecheck success does not compile fixture data through the widget compiler.

## Visual argument and evidence

The graph contrasts successful publication with one bounded repair branch, then separates main-owned publication from renderer display and opaque-origin generated code. Eight selectable entities retain actual branching: primary request, isolated specialist, compile gate, repair, artifact repository record, Pi transcript pointer, renderer viewer, sandboxed widget. Each selection discloses a specific source symbol/path in the artifact.

Verified implementation: `ProjectSessionIntegrationHost.generateInlineWidget` extracts the generation result, compile-checks, repairs once with diagnostics/context after a compile failure, then rechecks. A second failure propagates. `cake-artifact-operations.ts` persists before appending a Pi pointer. `WidgetArtifact`/`InlineWidgetStore` compile stored source separately for display. Repository payload authority and Pi pointer authority are deliberately distinct. This is a conceptual dependency map, not an execution trace; previous-success retention and an automatic explanation generator are explicitly not claimed.

Publication, repair, isolation and direct-neighbor highlighting share the same topology. Real React Flow supplies nodes, edges, arrow markers, handles, selection and keyboard focus. Authored prose and evidence remain ordinary React. The fixture imports no CSS; the agreed compiler contract supplies React Flow's stylesheet. ELK is not needed for this deliberately small authored layout.

## Revision record and limitations

An initial SVG draft was captured in actual Electron; the first panel image exposed excess vertical height and cramped labels. Labels and geometry were compacted. Before approval, the user redirected the task to actual React Flow inside the existing widget system. That SVG implementation was replaced, not shipped alongside Flow. Earlier screenshots are superseded and are **not evidence for the final fixture**.

The current authored coordinates are deliberately compact and use a separate wide layout at 1100px widget width, with adjacent details. Zoom and drag are disabled rather than fitting labels to illegibility. This is not automatic layout: variable labels, more entities, narrow widths below ~330px, edge-label collisions and accessibility behavior still require integrated capture/test review. Selection/evidence/path state is local ephemeral presentation state; fullscreen creates an independent iframe as in the first example.

## Integration verification handoff

After the compiler changes are landed into a fresh integrated assignment:

```sh
pnpm build
pnpm exec playwright test tests/electron/widget-pipeline-explanation.smoke.spec.ts
pnpm exec playwright test tests/electron/cake-request-explanation.smoke.spec.ts
pnpm visual:capture widget-pipeline-explanation --no-build --theme light --capture window
pnpm visual:capture widget-pipeline-explanation --no-build --theme dark --capture window
pnpm visual:capture widget-pipeline-explanation --no-build --theme light --state fullscreen
pnpm visual:capture widget-pipeline-explanation --no-build --theme dark --state fullscreen
```

Inspect all four captures; iterate geometry rather than accepting authored coordinates on faith. Add a narrow viewport capture. The new tests exercise real Flow element counts, publication/repair/neighborhood edge changes, pointer selection, keyboard node selection and disclosure, primary-label overflow, horizontal overflow, fullscreen, iframe policy and unavailable privileged globals/parent DOM. They are authored expectations, not passed results.

Current verification: build, typecheck and the four existing visual-capture unit tests pass. Oxfmt applied to changed TS and fixture TSX content. Oxlint/final lint remain blocked by pre-existing `extension-compatibility.ts:177` and `DiscussionReducer.ts:74,83`; no unrelated files changed.

## Kit implications, not another system

The first prototype demonstrates a guided boundary explanation. This second composition is intended to demonstrate a connected dependency graph **inside the same widget**, surrounded by prose, controls and evidence. Keep the shared surface/compiler; choose composition per explanation.

Already demonstrated by the first example: a theme/typography frame, boundary enclosure, accessible discrete controls and evidence disclosure. React Flow already provides connector ports, edge paths/markers and accessible selectable nodes; expose the library rather than cloning those in a bespoke graph kit. A production shared adapter for boundary backgrounds, path emphasis and accessible node-to-detail selection should be considered only after integrated verification. Automatic routing/layout, collision handling and variable-size label measurement are distinct diagram needs not proven by this authored fixture. Do not extract a universal schema or claim a general generator from it.
