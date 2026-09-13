# Widget publication paths — integrated React Flow verification

## Status: rendered and exercised in Electron

The fixture imports real `@xyflow/react` inside an ordinary React widget artifact. It does **not** introduce another artifact type, graph DSL, renderer canvas, generator, or shared-kit project. The user-approved first request explanation remains intact in `tests/fixtures/explanations/cake-request.react.txt`.

The integrated compiler now supplies approved React Flow and ELK imports and sandbox-local Flow CSS. Actual Electron tests and inspected captures prove the eight Flow nodes, eight directed edges, arrow markers, labels, path/neighborhood selection, keyboard node activation, and source disclosure. The separate inline-widget Electron test executes `new ELK().layout(...)` in an `allow-scripts` iframe and checks returned node positions, graph dimensions, and routed edge endpoints. That is runtime proof, not merely successful bundling; ELK is intentionally not used for this small authored layout.

**Automatic generation → screenshot review → visual revision remains unimplemented.** These are deterministic fixture-based integration checks and manually inspected captures, not an automated specialist quality-review workflow.

## Visual argument and source evidence

The graph contrasts successful publication with one bounded repair branch, then separates main-owned publication from renderer display and opaque-origin generated code. Eight selectable entities retain actual branching: primary request, isolated specialist, compile gate, repair, artifact repository record, Pi transcript pointer, renderer viewer, sandboxed widget. Each selection discloses a source symbol/path in the artifact.

`ProjectSessionIntegrationHost.generateInlineWidget` extracts the generation result, compile-checks, repairs once with diagnostics/context after a compile failure, then rechecks. A second failure propagates. `cake-artifact-operations.ts` persists before appending a Pi pointer. `WidgetArtifact`/`InlineWidgetStore` compile stored source separately for display. Repository payload authority and Pi pointer authority are deliberately distinct. This is a conceptual dependency map, not an execution trace; previous-success retention and an automatic explanation generator are not claimed.

Publication, repair, isolation and direct-neighbor highlighting share the same topology. Real React Flow supplies nodes, edges, arrow markers, handles, selection and keyboard focus. Authored prose and evidence remain ordinary React. The fixture imports no CSS and uses no remote libraries or privileged bridge.

## Reproduced defects and bounded fixes

- **Compiler shell media reset hid actual connectors.** Flow edge SVGs overflow an absolute container with zero width. The generic sandbox `svg{max-width:100%}` collapsed their viewport, even though paths and labels existed in the DOM. A Flow-local `max-width:none` exception is delivered alongside the approved library stylesheet. No generic widget reset, CSP, network allowance, or import policy was widened. Electron now asserts nonzero SVG viewport width as well as edge path length, stroke, labels and markers.
- **Fixture evidence CSS collided with Flow handles.** The generic `.source` class padded and colored Flow's source handles. Rename to `.evidence-source`; retain the actual library handles.
- **Controlled selection feedback undid path selection.** Consume actual `onNodesChange` selection changes instead of feeding `onSelectionChange` back into controlled node props. Tests cover repair, isolation, publication and neighborhood transitions, not only static classes.
- **Compact labels overflowed.** Shortened visible labels while preserving complete explanations and source references; corrected boundary-label specificity and compact boundary copy. Larger node geometry starts at 700px widget width, with side-by-side details at 1100px. Both compact and wide modes retain all nodes and edges without zooming them into illegibility.
- The capture scenario now waits for measured Flow nodes and an actual edge label, not merely the surrounding heading. Keyboard tests wait for node visibility and assert focus before Enter, respecting Flow's asynchronous node measurement.

## Verification and captures

Run from the integrated checkout:

```sh
pnpm build
pnpm exec playwright test tests/electron/widget-pipeline-explanation.smoke.spec.ts tests/electron/cake-request-explanation.smoke.spec.ts tests/electron/inline-widget.smoke.spec.ts
pnpm test tests/app/visual-capture.test.ts
pnpm test:integration tests/integration/inline-widget-compiler.test.ts
pnpm visual:capture widget-pipeline-explanation --no-build --theme light --capture window
pnpm visual:capture widget-pipeline-explanation --no-build --theme dark --capture window
pnpm visual:capture widget-pipeline-explanation --no-build --theme light --state fullscreen
pnpm visual:capture widget-pipeline-explanation --no-build --theme dark --state fullscreen
pnpm visual:capture widget-pipeline-explanation --no-build --theme light --state fullscreen --width 760 --height 1000
```

Passed: five Electron cases (Flow and first walkthrough in both themes, plus React/ELK execution), four visual-harness unit tests, six compiler integration tests, typecheck and build. Oxfmt and focused Oxlint cover changed source/tests. Repository Oxlint remains blocked by pre-existing `extension-compatibility.ts:177` and `DiscussionReducer.ts:74,83` findings.

Inspected final real-Flow PNGs under `.visual-captures/`:

- `widget-pipeline-explanation-default-light-window-1280x900.png`
- `widget-pipeline-explanation-default-dark-window-1280x900.png`
- `widget-pipeline-explanation-fullscreen-light-region-1280x900.png`
- `widget-pipeline-explanation-fullscreen-dark-region-1280x900.png`
- `widget-pipeline-explanation-fullscreen-light-region-760x1000.png`

The normal panel exercises a roughly 354px iframe with a compact, readable graph; details are reached by scrolling. Fullscreen shows the diagram beside evidence at 1280px, and stacks it at the app's 760px minimum window width. A requested 360px app-window capture cannot settle because Electron enforces that minimum; no product/harness sizing policy was changed. Tests assert node containment and primary-label fit at 760px as well as normal-panel/fullscreen overflow, actual selection and disclosure, opaque-origin restrictions, and absence of Node/Cake globals or parent DOM access.

Earlier SVG draft screenshots are superseded and are **not evidence for this fixture**. Earlier blocked React Flow tests belonged to an isolated checkout without compiler integration; those limitations are resolved by this integrated pass.

## Remaining limits

This deliberately laid-out eight-node example is not proof of arbitrary automatic routing, variable-size labels, dense graph collision handling, or layouts below the tested compact panel width. Flow zoom/drag are disabled intentionally. State is local ephemeral presentation state; fullscreen creates an independent iframe. There is no new generation/preview backend, atomic successful-revision policy, or automatic screenshot-review loop.

Keep one widget composition surface. React Flow already provides connector ports, paths/markers and accessible selectable nodes; exposing that library is preferable to cloning it into another graph DSL. Consider higher-level helpers only after more generated compositions establish a concrete need.
