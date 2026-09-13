# Interactive explanations: implementation plan

## Product decision

Build a diagram-design workflow, not a replacement node-and-edge DSL. The specialist receives an explanation goal, audience, verified facts and source references, and chooses an appropriate interactive visual form. Its output is sandboxed React/SVG composed with curated visual primitives. React Flow or a layout engine may be tools, but neither dictates the artifact format. Mermaid may be an optional sketch, not the mandatory intermediate representation.

The existing architecture graph renderer has no preservation requirement. Existing independent artifact persistence, widget sandbox/compiler, and Pi service boundaries may be reused when appropriate. Do not repair the old graph renderer as this project's objective.

### Clarified direction: one widget system with diagram capabilities

The user approved the first visual example but correctly noted that authored React widgets already exist. The product improvement must be integrated capabilities and generation quality, not more standalone widget examples or a parallel explanation artifact type. Keep one React widget authoring/rendering path and make React Flow plus ELK available as approved sandbox libraries. A generated widget can combine an actual flow diagram with prose, controls, filtering, and detail panels using ordinary React composition. No mandatory Cake node-edge DSL or separate flow-widget product. Evolve the existing widget specialist's guidance and eventually its rendered-review workflow; earlier runtime-note proposals for a separate public explanation operation are not the chosen product direction.

Immediate implementation contract: approved imports `@xyflow/react` and `elkjs/lib/elk.bundled.js` in the existing widget compiler, with React Flow's required CSS delivered inside the sandbox (not a host-global import or a model-loaded URL). Preserve existing generic widget CSP behavior; do not widen it for these dependencies. No package installation is expected: both packages are already pinned. Use the library APIs directly for this slice; extract higher-level helpers only after demonstrated need.

## First milestone: prove the experience

Produce one excellent interactive explanation of Cake on the actual Electron sandboxed artifact surface, with normal-panel and fullscreen captures and verified interactions. Manually exercise generation and visual revision before implementing an automatic generation service. If the result is not compelling, change the design before building more infrastructure.

First-stage assignments (separate Cake-managed child worktrees):

| Owner/model                | Assignment                                                                                               | Deliverable                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Visual prototype / Astra   | Choose and implement a polished visual explanation; inspect actual rendered captures and revise          | Runnable prototype, source-backed brief, screenshots, targeted verification, proposed minimal kit                                |
| Runtime design / Sol       | Inspect widget, artifact, Pi, sandbox and capture boundaries; design the smallest production workflow    | Focused design note with concrete interfaces, ownership, reuse, risks and implementation steps; no production implementation yet |
| Evaluation fixtures / Luna | Prepare source-backed request-flow, process-boundary and dense-dependency briefs and evaluation criteria | Deterministic benchmark data and capture handoff; extend independent harness support only if necessary and coordinated           |

The parent owns shared decisions and integration. Children must not merge or resolve themselves; the parent lands work serially through Cake. Report one substantive result with changed files, verification, screenshots where relevant, and blockers. Do not wait on siblings or exchange acknowledgment-only messages.

## Scope and ownership

- Astra owns prototype-specific files and any minimal visual primitives it needs; new authoritative UI primitives belong in `src/renderer/components/ui/` and the catalog. Do not fork the chat or artifact infrastructure.
- Sol owns `docs/development/interactive-explanations-runtime.md` for this stage. Runtime changes require a subsequent implementation assignment.
- Luna owns `docs/development/interactive-explanations-benchmarks.md` and new benchmark fixture files. Existing shared visual-harness registration is reserved to Astra during the prototype stage; report needed integration points rather than making conflicting edits.
- The parent owns this plan and final shared contracts. Contract proposals remain proposals until integrated.
- Follow repository styling, state ownership, sandbox, Pi integration, worktree, and verification rules. The user explicitly chose bespoke sandboxed visualizations over the current architecture-graph skill's structured graph path for this project.

## Acceptance criteria

- The main idea is readable at normal panel size without zooming.
- Composition suits the explanation rather than forcing a graph.
- Selection, focus or progressive disclosure materially clarifies the explanation.
- Important factual claims have source references; interpretation is marked.
- No clipping or overlapping primary labels at tested sizes and themes.
- Actual interactions are verified in isolated Electron, not inferred from jsdom.
- Generated code retains the sandbox: no privileged renderer imports, arbitrary filesystem access, network access, or raw host bridges.
- Screenshots are reviewed as visual evidence, not substituted for workflow tests.

## Subsequent stages (gated on prototype review)

1. Try a second, structurally different explanation and extract only demonstrated reusable primitives.
2. Agree on a small brief/result contract and approved visualization kit imports.
3. Split kit/artifact UX (Astra) from generation/preview pipeline (Sol).
4. Implement initial generation plus at most two revision attempts, actual rendered feedback, cancellation, explicit failure/fallback, and atomic publication of successful revisions. Failed revision keeps the previous successful artifact.
5. Verify authoritative operation through renderer publication with deterministic boundary fakes, plus targeted Electron interactions and visual capture.
6. Use Luna for bounded benchmark/documentation/cleanup tasks and Astra for final visual critique.
7. Remove the replaced graph-specific API, renderer, obsolete tests and instructions when the replacement is integrated; do not carry compatibility shims.

## Runtime model policy

Prototype with Astra to establish the quality ceiling. Compare Sol only after the workflow is effective using the same briefs, visual quality, fidelity, repair count, latency and cost. Do not spend model calls on checks deterministic code can perform. Route any shipped specialist execution through Cake's Pi service boundary and explicit model configuration; implementation-child model selection does not itself define a product preference.

## Status

- Planning: agreed with user.
- First-stage children: launched in isolated Cake-managed worktrees:
  - [Visual prototype — Astra](cake://session/17889033-ae4f-4f23-998e-6fca90e8868a).
  - [Runtime design — Sol](cake://session/26b42ee1-1068-4952-9493-724c8fb2bd27).
  - [Evaluation fixtures — Luna](cake://session/a11c43f6-88c2-4e23-9ef8-ecd1fe38165b).
- First-stage prototype, runtime design, and benchmarks: reviewed and landed in the parent worktree.
- User approved Astra's guided visual explanation and explicitly requires that genuine diagrams remain an available form, not just walkthroughs.
- React Flow/ELK compiler support and Astra's real-Flow second fixture are now landed in the parent worktree. The parent updated both generation and repair guidance and the widget tool description; focused prompt/compiler tests, typecheck, formatting and build pass. Full lint remains blocked by pre-existing DiscussionReducer and extension-compatibility findings.
- Next milestone: integrated Electron visual/interaction verification and refinement of the real Flow fixture. Its earlier isolated-checkout runs were blocked by missing compiler support and are not accepted visual evidence.
- The second composition must demonstrate connected nodes, readable edges, meaningful boundaries and useful path/neighborhood interaction within a React widget, not another hand-authored SVG-only proof or a repair of the old architecture canvas.
- Automatic screenshot-review pipeline: still unimplemented; develop it as an improvement to the widget generation path, not a separate product.
