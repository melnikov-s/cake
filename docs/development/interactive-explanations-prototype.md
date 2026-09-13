# Interactive explanation prototype: a prompt through Cake

## The visual argument

**The conversation crosses; the authority stays put.** This is a source-backed field guide for a developer learning Cake, not a generated call trace. Two nested process enclosures and one narrow crossing explain the important distinction more directly than a node-edge graph. The Pi runtime is visibly **inside main**. Selecting a journey stop changes the highlighted authority, explanatory claim, and inspectable source evidence. The final stop reverses the transport label to updates.

At normal artifact-panel width the composition is a compact vertical reading sequence. Fullscreen turns into a two-column plate with generous typography and adjacent evidence. This is one bespoke React composition, not a DSL, graph renderer, or production specialist pipeline.

## Verified sources

Paths and ranges refer to the prototype's repository checkout, not a future web/server design.

| Claim                                                                                                                | Evidence                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A typed renderer Client sends `sessionChats.prompt` through the generated RPC client                                 | `src/renderer/client/ClientLive.ts:273–279`                                                                   |
| Preload exposes only frozen `cake.rpc` send/subscribe; raw Electron IPC stays private                                | `src/preload/preload.ts:5–19`                                                                                 |
| Main binds the originating renderer connection before delivering the prompt                                          | `src/ipc/server/SessionChatHandlers.ts:6–20`                                                                  |
| Pi service prompt enters its runtime turn operation                                                                  | `src/services/pi/PiSessions.ts:596–598` (see the preceding `startTurn` implementation for adapter delegation) |
| Main embeds Pi; extensions share main privilege; renderer is sandboxed; shared schemas validate receiving boundaries | `docs/architecture/cake-architecture.md`, Process boundaries                                                  |
| Window observers update projections, not a competing transcript authority                                            | `docs/architecture/cake-architecture.md:135–150`, and Ownership                                               |

The five stops are **interpretation**: a conceptual ordering. They omit queue policy, cancellation, tools, provider I/O, retries and individual event types. Preload is a boundary strip, not a third process. “Validated values” describes the receiving transport/RPC boundaries, not parsing in `preload.ts` itself. Pi ownership claims are architectural; the short implementation excerpts establish entry points, not the entire agent-loop implementation.

## Authoring and replay

The manually authored source is artifact **data** in `tests/fixtures/explanations/cake-request.react.txt`. The fixture is compiled by the real widget compiler when the artifact opens; it imports only React. It runs in the existing `cake-widget:` document with `sandbox="allow-scripts"` and display capability. No renderer imports, raw host bridge, filesystem, network, alternate browser preview or generation backend were added.

The existing compiler permits React/D3 imports only and has no curated UI kit/Tailwind environment. The source therefore contains a self-contained visual style and native accessible controls as sandbox artifact data, not a feature-local replacement for renderer UI. This is a deliberate prototype constraint, **not** the proposed production authoring standard. A kit/compiler decision remains gated on prototype review.

```sh
pnpm build
pnpm exec playwright test tests/electron/cake-request-explanation.smoke.spec.ts
pnpm visual:capture cake-request-explanation --no-build --theme dark --capture window
pnpm visual:capture cake-request-explanation --no-build --theme light --state fullscreen
```

The harness supports `default`, `selected` (Pi + evidence), and `fullscreen` (Pi + evidence). Its temporary fixture persists a real session-scoped widget artifact and opens the actual artifact workspace. It does not exercise specialist generation or live publication; these remain subsequent milestones. Source references are inspectable text, not privileged file-opening links.

## Visual revision record

1. First real Electron capture showed an over-tall panel: the selected explanation and controls fell below the fold. It also exposed an OS-light document inside Cake's dark theme.
2. Revised the narrow layout: shorter spacing and enclosure labels; removed secondary introduction/caption at narrow widths while retaining the core claim, process ownership, five steps and primary interaction. At a 1280×900 app viewport, the default panel shows the claim, complete map, selected explanation and both controls without zooming or scrolling.
3. Made capture media color scheme deterministic alongside the host theme, so sandbox documents are genuinely captured in both themes. This is capture infrastructure, not theme synchronization in the shipping product.
4. Fullscreen exposed an existing real defect: the widget iframe had native 300×150 sizing. Added only `h-full w-full border-none` to its existing fullscreen iframe. No new fullscreen implementation.
5. Reviewed light/dark normal-panel and fullscreen captures. Fullscreen uses the same artifact at the real viewport, not a stretched screenshot. Harness interactions wait for the selected heading before opening evidence.

Images are Git-ignored under `.visual-captures/cake-request-explanation-*`. The full-window normal capture is the clearest evidence of actual available panel space; region screenshots may extend beyond the ancestor's scroll viewport.

## Ownership and limitations

- Selected stop and evidence disclosure are transient, local presentation state inside each sandbox document. They have no authoritative application meaning, persistence or asynchronous concurrency. Fullscreen currently creates another iframe, so it starts at Compose; closing it preserves the normal panel's independent state. This prototype does not attempt host state synchronization.
- Artifact storage, compiler diagnostics, sandbox policy, repair UI and fullscreen lifecycle remain with existing Cake owners.
- Evidence expansion can require normal panel scrolling. The main idea and interaction do not.
- The authored palette follows the document's media preference. Shipping Cake theme overrides are not passed into widget documents today. Smallest subsequent fix: a validated theme input at the widget shell, not generated code reading host DOM.
- No production kit, automatic generation, revision service, old API removal or architecture canvas patch is included.

## Smallest kit suggested by this example

Extract only after a second structurally different explanation:

1. **Explanation frame**: typography, theme tokens, compact/wide reading layout, interpretation caption.
2. **Step selector**: keyboard-accessible discrete selection with an active indicator; no graph semantics.
3. **Boundary enclosure**: title, authority label, nested content and focus treatment. Nesting is authored, not computed graph containment.
4. **Evidence disclosure**: claim + repository path/range, clearly distinguished from interpretation.

Use established sandbox-safe Button/Disclosure controls under these pieces when defining approved kit imports. Do not expose a universal node-edge schema, layout algorithm or workflow Store based on this example alone.

## Verification

- `pnpm build`: passed.
- Targeted isolated Electron tests: 4 passed (the two explanation theme cases, existing inline-widget smoke, existing visual-capture smoke); real artifact loading/compilation, sandbox attributes and absent privileged globals, visible initial control at normal width, keyboard evidence disclosure, all meaningful journey transitions, evidence updates, fullscreen dimensions/interaction, and close behavior.
- `pnpm test tests/app/visual-capture.test.ts`: 4 passed.
- `pnpm typecheck` and `pnpm format:check`: passed.
- `pnpm lint:oxlint` and `pnpm lint`: blocked by existing errors in `src/services/pi/runtime/extension-compatibility.ts:177` and `src/renderer/reducers/DiscussionReducer.ts:74,83`; unrelated files were not modified.
