# Interactive explanations: implementation plan

## Product decision

Build a diagram-design workflow, not a replacement node-and-edge DSL. The specialist receives an explanation goal, audience, verified facts and source references, and chooses an appropriate interactive visual form. Its output is sandboxed React/SVG composed with curated visual primitives. D3 may be a tool, but it does not dictate the artifact format. Mermaid may be an optional sketch, not the mandatory intermediate representation.

The obsolete architecture graph renderer and authoring API were removed after the unified widget path was integrated. Historical stored graph records are projected to their readable Markdown fallbacks without rewriting immutable blobs or Pi history.

### Clarified direction: one widget system with diagram capabilities

Authored React widgets already provide the product surface. The improvement is generation quality, not more standalone widget examples or a parallel explanation artifact type. Keep one React widget authoring and rendering path. Generated widgets can combine SVG/D3 diagrams with prose, controls, filtering, and detail panels using ordinary React composition. There is no mandatory Cake node-edge DSL or separate flow-widget product.

React Flow and ELK were removed after their prototype did not demonstrate enough value over React and SVG/D3 to justify dedicated dependencies, compiler resolution paths, specialist instructions, and test surface. Preserve the existing generic widget CSP behavior and do not widen it for visualization dependencies.

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
- Follow repository styling, state ownership, sandbox, Pi integration, worktree, and verification rules. Architecture guidance uses the unified `widgets.present` path with a semantic, source-backed brief.

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
- The React Flow and ELK prototype and compiler support were later removed because they did not demonstrate enough product value to justify their dedicated runtime and test surface. React and SVG/D3 remain available for custom interactive diagrams.
- [Widget visual-review implementation — Sol](cake://session/f22b7f8e-3d4e-49f3-8a52-251a045e2336) delivered the wired domain policy, preview/capture and specialist acceptance path. Parent reviewed two correction rounds and landed the implementation. Deterministic tests cover replacement/cancellation/serialization policy; actual Electron verifies settled widget-only pixels, preview cleanup and post-readiness resize. No real provider-quality benchmark is claimed.
- Runtime implementation preserves configured/caller model selection and explicitly requires image support, rather than hardcoding a preset name or silently skipping screenshot review. A dedicated specialist-model preference can be an explicit later decision.
- Automatic visual review is implemented in the working branch. The separate graph authoring tool/schema/renderer is removed. Architecture instructions use widgets, while a bounded storage-read migration projects historical graph records to their existing Markdown fallbacks without rewriting Pi history.
- The original implementation passed typecheck, formatting, build, fast tests, compiler integration tests, and targeted Electron cases covering walkthroughs, existing artifacts, capture, cancellation, and post-ready sizing.
- New-code lint findings were fixed during the original implementation.
- Ready for Cake-managed merge into the main checkout; not deployed to the running application yet. All child implementation work is integrated. No real-provider aesthetic-quality benchmark is claimed.
