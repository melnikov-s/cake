# Interactive explanations: minimal production runtime design

## Decision and scope

The production path should orchestrate a specialist-designed artifact, not restore the old
architecture renderer and not introduce a node-edge or Mermaid intermediate language. The input is
a source-backed explanation brief; the specialist chooses the visual form and returns one
self-contained React component using a deliberately small import surface. Cake compile-checks and
renders that component in its existing opaque-origin widget sandbox, gives the same specialist
actual rendered feedback, allows at most two replacement revisions, and publishes only a successful
candidate as an immutable `widget` artifact revision.

This note records the original runtime proposal. The implemented `widgets.present` path now performs
mandatory capture of every renderable candidate in the bound Cake Electron renderer, with at most two
replacement revisions shared by compile, runtime, and visual fixes. The initial generation and each
visual-review/repair turn currently use separate persisted restricted Pi sessions with the same
resolved model and full bounded source/context, rather than reopening one specialist transcript.
Attached PNGs therefore persist in those private widget-session JSONL transcripts under Cake's
existing session retention policy. The artifact is persisted only after a screenshot-reviewed
candidate is accepted.

## What already exists at the current boundary

The following pieces are independently useful and should be reused rather than copied:

- **Artifact authority and revisions.** `src/services/storage/ArtifactStorageLive.ts` serializes
  updates per working-directory/session/artifact key, writes SHA-256-addressed blobs, atomically
  writes metadata, requires revision 1 for a new lineage, and requires exactly `current + 1`
  thereafter. `src/ipc/artifact-contract.ts` already has a bounded `widget` artifact carrying React
  source, brief, fallback, and generation-session identity. `ProjectSessionIntegrationHost`
  publishes repository updates, while session snapshots and `src/renderer/observers/artifact-events.ts`
  hydrate/update the renderer projection. This is the publication authority; candidate attempts
  must not become a second artifact repository.
- **Compiler and sandbox.** `src/services/widgets/inline-widget-service.ts` limits source to 1 MiB,
  uses esbuild, requires a default-exported React component, and rejects imports except React and
  the explicit D3 allowlist. `src/services/widgets/inline-widget-protocol.ts` serves an in-memory
  compiled document at a per-compilation `cake-widget:` capability URL with `default-src 'none'`,
  no forms/navigation/base URL, no `connect-src` override (so fetch/XHR/WebSocket inherit
  `default-src 'none'`), and only inline script/style. The current CSP is **not complete network
  isolation**: it explicitly permits `img-src data: https:` and `media-src data: https:`, so
  generated markup can still request passive remote images or media even though the frame sends no
  referrer. `src/renderer/components/widget-artifact.tsx` embeds it with
  `sandbox="allow-scripts"` (no `allow-same-origin`) and accepts only token-correlated `ready`,
  `height`, and `error` messages from that exact frame. Fullscreen uses the same compiled URL and
  sandbox. This is the right execution surface, with the remote-media caveat addressed below.
- **Restricted Pi execution.** `src/services/pi/runtime/isolated-session-runner.ts` creates a Pi
  agent session with project trust disabled and supports no-tools operation, a selected Pi model,
  thinking level, `AbortSignal`-driven `session.abort()`, persisted or ephemeral history, and live
  part/usage callbacks. `sidecar-runtime.ts` already supplies generation/repair prompts that treat
  source and brief as untrusted data. This is implementation evidence, not a reason to keep
  orchestration in `ProjectSessionIntegrationHost`: new Pi integration belongs behind
  `src/services/pi`, and Pi remains the agent-loop/provider authority.
- **Configured model resolution.** `CakeModelSelection` in
  `src/domain/model-presets/cake-model-selection.ts` defines a string as a configured preset name,
  never a raw model ID, and resolves it to provider, `modelId`, thinking level, and Fast mode.
  `PiModels.resolve` then checks catalog membership, authentication, availability, supported
  thinking level, and Fast mode. `PiModel.input` also records whether image input is supported.
  In contrast, today's widget path copies only the current session's provider/model into
  `runInlineWidgetGeneration`; it does not carry a full configured selection and has no rendered
  review loop.
- **Renderer workflow pattern.** Renderer Stores call the Promise `Client`, own cancellation and
  late-result rejection, and do not import Effect. `ArtifactWorkspaceStore` already owns the
  session accessory panel and opens a newly received artifact. `InlineWidgetStore` currently owns
  renderer-local compile/repair state, but its repair changes only local source; it does not create
  an immutable artifact revision and therefore is not the production revision authority.
- **Test-only visual capture.** `scripts/visual-capture/capture.ts` launches the compiled Electron
  app with isolated `CAKE_HOME`, lets a named scenario prepare a real renderer, and calls Playwright
  `page`/`Locator.screenshot()`. `scripts/visual-capture/scenarios.ts` contains scenario-owned
  selectors and interactions, including artifact fullscreen. This is excellent deterministic test
  evidence, but it is a developer CLI in a second Playwright-controlled Electron process. It is
  not callable by a running Cake workflow and must not be treated as a runtime screenshot service.

The current path therefore proves generation, syntax repair, sandbox execution, persistence, and
manual repair separately. It does **not** provide pre-publication rendered review, visual input back
to the specialist, durable revised artifact publication, or a cancellable long-lived generation
operation.

## Minimal product contract

Subject to prototype review, the proposed public request should remain semantic and source-backed.
Its exact operation name and exposure are not decided by this note. It should not expose generated
source, layout coordinates, a graph DSL, compiler options, or capture selectors.

```ts
interface InteractiveExplanationBrief {
  readonly id: string; // stable artifact lineage within the Cake Session
  readonly title: string;
  readonly goal: string;
  readonly audience: string;
  readonly verifiedFacts: ReadonlyArray<{
    readonly id: string;
    readonly statement: string;
    readonly sourceRefs: ReadonlyArray<SourceLocation>;
  }>;
  readonly sourceRefs: ReadonlyArray<SourceLocation>;
  readonly data?: JsonValue;
  readonly fallback: { readonly markdown: string };
}

interface GenerateInteractiveExplanationInput {
  readonly sessionId: string;
  readonly brief: InteractiveExplanationBrief;
  // Initially supplied by Cake policy as the configured preset name "Astra".
  readonly model: CakeModelSelection;
}

interface InteractiveExplanationAccepted {
  readonly operationId: string;
}
```

All strings, arrays, source locations, JSON depth/size, and total encoded input need explicit
Effect Schema bounds. The existing artifact limits are a ceiling, not an invitation to send 1 MiB
to the specialist. The operation returns an ID immediately; progress is observed separately so RPC
request interruption is not confused with cancelling accepted work.

```ts
type InteractiveExplanationPhase =
  | "queued"
  | "generating"
  | "compiling"
  | "rendering"
  | "reviewing"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled";

interface InteractiveExplanationSnapshot {
  readonly operationId: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly phase: InteractiveExplanationPhase;
  readonly attempt: 0 | 1 | 2; // candidate 0 is initial; candidates 1–2 are replacements
  readonly diagnostic?: string; // bounded, user-safe summary
  readonly warning?: string; // post-commit pointer/event publication warning
  readonly published?: ArtifactRecord;
}
```

Commands are `start`, `cancel`, and a current-first `observe(operationId)` subscription. Start
rejects another active operation for the same `(sessionId, artifactId)`; different artifacts may
run independently under a small process-wide bound. Before publication begins, cancel is idempotent
and interrupts generation, compilation/capture waiting, and specialist revision. It is not merely a
renderer visibility flag. Once the publication commit boundary begins, cancel returns the eventual
committed outcome rather than claiming that committed work was cancelled.

### Visual-kit contract

The first kit should be extracted from successful prototypes, not designed speculatively. The
compiler allowlist should add one stable module specifier such as `@cake/explanation-kit` whose
runtime implementation is bundled by main. It may export presentation-only primitives and tokens
(e.g. frame, section, callout, selectable region, source badge, responsive SVG helpers). D3
submodules can remain approved; a graph/layout library is optional only when a prototype proves it
necessary. No kit API may expose Cake IPC, files, network, credentials, parent DOM, navigation, or
arbitrary component imports. For explanation candidates, add a tighter compiler/publication
capability whose CSP removes the current widget sandbox's HTTPS image/media allowances
(`img-src data:; media-src data:` unless a demonstrated prototype needs something narrower), so the
specialist cannot cause passive remote requests. Do not silently describe the generic reused policy
as already providing that restriction. Source references remain inert validated data inside the
frame in the first version; opening a workspace source would require a separately designed
token-correlated host intent.

## Runtime workflow

A main-process `interactiveExplanations` domain module should own this policy:

1. **Authorize and snapshot.** Resolve the Project Session to an allowed Working Directory. Read
   the current artifact record, if any, and reserve the `(sessionId, artifactId)` key. Resolve the
   configured preset `"Astra"` through `resolveCakeModelSelection` and then `PiModels.resolve`.
   Do not interpret `"Astra"` as a provider model ID and do not fall back to the conversation or
   utility model. Require `input` to include `image`, because rendered critique is part of this
   workflow. A missing, ambiguous, unauthenticated, unavailable, non-vision, or unsupported Astra
   configuration is an explicit preflight failure before a specialist session starts.
2. **Generate.** Acquire one restricted specialist Pi runtime through the `src/services/pi`
   boundary: no tools, extensions, skills, prompt templates, context files, project trust, Cake
   controls, or filesystem access. Give it only the bounded brief and kit/API instructions. Apply
   the resolved provider/model, thinking level, and Fast mode snapshot. Persist the private Pi
   session so replacement and acceptance feedback turns retain design context, but never expose its
   Pi Session identity to the renderer or copy its transcript into the Project Session. The maximum
   is one initial generation turn plus three feedback turns: at most two feedback turns may produce
   replacement source, and a final rendered candidate still needs a screenshot-review turn that can
   accept it unchanged.
3. **Compile.** Extract exactly one fenced/default-exported React component and compile through
   `InlineWidgets`. Compiler failures become bounded diagnostics. The same specialist may revise
   after a compiler failure. A compile pass does not trigger a separate model call that merely
   restates the diagnostic result, but it still proceeds to the mandatory rendered screenshot review.
4. **Render and inspect.** Main mounts the candidate in a fixed 560×480 hidden offscreen Electron
   host containing the same opaque-origin, `allow-scripts` sandbox iframe used for publication. Wait
   for token-correlated `ready` after stabilized height/fonts and bounded layout settling, collect
   runtime errors and deterministic viewport/overflow/device-scale diagnostics, then capture the
   actual Electron pixels as described below. No Project Session renderer participates.
5. **Review every rendered candidate; revise at most twice.** After the initial candidate—and after
   every revision that reaches a renderable state—send the same specialist the bounded diagnostics
   and PNG as Pi image content. Passing compile, runtime, and layout checks never bypasses this first
   screenshot review. The response contract allows either an exact `ACCEPT_CURRENT` decision or one
   complete replacement component. `ACCEPT_CURRENT` publishes the unchanged candidate; replacement
   source consumes one revision, then must be recompiled, rerendered, recaptured, and reviewed again.
   A compiler/runtime failure also consumes a revision when the specialist returns replacement
   source. After two replacements, the final screenshot is still reviewed: it may be accepted
   unchanged, but another requested replacement exhausts the budget and fails explicitly. Thus
   candidate attempts are numbered 0–2 whether or not each candidate compiles, while zero to three
   successfully rendered candidates receive screenshot review. There is no numerical beauty score
   and deterministic checks cannot accept on the specialist's behalf.
6. **Publish.** Only an accepted candidate that compiled, reached ready without runtime error, and
   passed the required render checks is converted to a `widget` artifact. Its revision is 1 or
   exactly the stored revision plus one. Persist through `ArtifactStorage.upsert`, append the
   ordinary immutable artifact pointer to Pi where the invoking operation contract requires it, and
   emit the existing `artifact-updated` event. The renderer then uses its normal artifact
   projection/panel flow. “Atomic publication” means the artifact authority advances once through
   its existing atomic metadata replacement; no rejected candidate writes that metadata.

   The **cancellation commit boundary** is the call to `ArtifactStorage.upsert`: cancellation wins
   only when observed before that call begins. Publication is then a short non-cancellable section.
   If `upsert` succeeds, the new revision is committed and the operation must settle as completed,
   even if cancellation arrives or pointer/event publication later fails. Cake may make one bounded
   immediate retry for the pointer/event; if it still fails, report a completed-with-warning outcome
   and rely on normal artifact storage hydration to expose the committed revision. Do not claim the
   old revision survived and do not add a cross-authority transaction or rollback. If `upsert`
   fails, no commit occurred and the operation fails normally. Destroy the hidden capture host and
   discard capture bytes after settlement.

7. **Fail or cancel truthfully.** Before the publication boundary, exhausted attempts, model
   failure, capture-host loss, timeout, or cancellation destroys the hidden host and settles with a typed
   failure/cancellation. No rejected pre-commit candidate calls `upsert`, appends a pointer, or emits
   `artifact-updated`; a prior successful revision stays selected/renderable. After a successful
   `upsert`, use the committed outcome above rather than reporting failure or cancellation.

Every replacement returned after compiler, runtime, layout, or screenshot feedback consumes the
same two-replacement budget; compiler failure does not get an additional hidden repair path. This
keeps the product promise simple: one initial candidate plus at most two specialist replacements,
regardless of whether each candidate reaches rendering. Every candidate that does render is
reviewed, including candidate 2 before acceptance.

## Actual Electron rendered-feedback path

A runtime capture capability is the one material capability that does not exist today.

Use a focused main-owned `RenderedSurfaceCapture` Service, implemented with Electron's
`BrowserWindow.webContents.capturePage(rect)`. Do **not** run the Playwright visual-capture CLI from
production, use `desktopCapturer`, ask for screen/window media, or let generated code request
capture. `capturePage` captures Cake's own compositor output, including the cross-origin sandboxed
iframe, and does not require macOS Screen Recording/display-media permission because it is not
capturing another application or the desktop. The Live implementation should nevertheless surface
Electron capture failures as typed errors rather than assuming availability.

The Service owns a fixed-size, frameless `BrowserWindow` configured with `show: false`, offscreen
rendering, sandboxing, context isolation, no Node integration, no focus or
taskbar presence, and denied permissions/popups. Its data-URL host may frame only `cake-widget:` and
creates an iframe with `sandbox="allow-scripts"` and no referrer. Main accepts only token-correlated
widget bridge messages from that frame, bounds diagnostics and runtime errors, and captures the
entire deterministic content viewport after two animation frames. The window is never registered as
a renderer connection or associated with a Project Session.

Main attaches the PNG to the private specialist prompt
as base64 `image/png`; it is not exposed through preload, written to the Project, or persisted in
the artifact repository. It is **not memory-only** when the specialist Pi Session is persisted:
Pi 0.85.1 builds the user message with the supplied image blocks and
`AgentSession._handleAgentEvent` passes the completed user message to
`SessionManager.appendMessage`, so the base64 image is stored in that private Pi JSONL transcript.
The specialist-session retention/deletion policy therefore also governs screenshot retention. A
debug export can be a later explicit user action, not default behavior.

The render and capture run in the operation Scope and serialize process-wide through one Service-owned
semaphore. Abort destroys a host that is still preparing. Electron's `capturePage` Promise has no
native abort parameter, so once capture begins the native call, serialization permit, and window stay
alive until it settles; cancellation then discards the late `NativeImage` and prevents review or
publication. Scope finalization always destroys the window, and candidate finalization always revokes
the transient compiled token.

Runtime capture is evidence fed to the
specialist; the repository visual harness remains the deterministic developer/CI tool for named
fixtures and reviewed screenshots. Neither replaces targeted Electron interaction tests.

## Ownership and state classification

| State/fact                                 | Authority and cohesive owner                                                                                   | Lifetime                                                                                  | Persistence                                                                 | Concurrency/cancellation                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Brief and source references                | Invoking Project Session operation input; validated Cake domain value                                          | Operation, then embedded in published widget payload/fallback as needed                   | Artifact repository only after success; readable pointer/fallback in Pi     | Immutable snapshot                                                             |
| Specialist model policy                    | Cake configured Model Presets; `interactiveExplanations` snapshots resolved selection, Pi validates capability | Resolution at operation start                                                             | Existing Cake application configuration                                     | No fallback or live rebinding during a run                                     |
| Specialist transcript                      | Pi Session / restricted Pi runtime                                                                             | Initial generation plus up to three feedback turns; at most two return replacement source | Private Pi session directory; retention/cleanup policy like widget sidecars | One serialized turn; operation abort calls Pi abort and releases Scope         |
| Candidate source and compiled capability   | Main operation coordinator plus `InlineWidgets`/scheme registry                                                | One attempt                                                                               | None                                                                        | Replaced only by next attempt; old token invalidated/removed                   |
| Capture readiness, bounds, and diagnostics | Main-owned hidden offscreen capture host                                                                       | One mounted attempt                                                                       | None                                                                        | Process-wide serialization; abort/finalization destroys host                   |
| PNG feedback                               | Electron main until prompt handoff; then Pi owns the private specialist message                                | Operation plus retained private Pi Session                                                | Base64 image persists in private Pi JSONL; never artifact/Project storage   | Capture serialized process-wide; late native results discarded after cancel    |
| Operation phase/progress                   | Main process operation coordinator; renderer gets current-first projection                                     | Accepted operation/process lifetime                                                       | None in v1                                                                  | Reject same artifact while active; bounded global parallelism; explicit cancel |
| Published artifact revision                | `ArtifactStorage`                                                                                              | Session/artifact lineage                                                                  | Content-addressed immutable blob plus atomic metadata; Pi pointer           | Existing per-artifact serialization and exact `+1` revision rule               |
| Artifact panel selection/open state        | Existing session `ArtifactWorkspaceStore`                                                                      | Loaded Project Session Store                                                              | Existing renderer policy (currently not snapshot-decorated)                 | Existing event ordering; not workflow authority                                |

Effect belongs in Services, the free `interactiveExplanations` domain operation, and main runtime composition. No renderer Store, RPC, event, component, or app mount exists for pre-publication capture.

## Failure and trust boundaries

- The specialist sees only the declared brief, kit contract, its prior private turns, compiler/render
  diagnostics, and Cake's own capture. Brief/source/code/diagnostics are quoted as untrusted data.
  It receives no project files or tools.
- Generated source is untrusted at every attempt. It never imports renderer components directly and
  never executes in main or Cake's renderer origin. Compilation is not sanitization; the opaque
  origin, iframe sandbox, CSP, import allowlist, token checking, and bounded messages remain
  mandatory. The generic current CSP still permits HTTPS image/media loads; the proposed
  explanation-only capability must remove those allowances before claiming network isolation.
- The renderer and preload are untrusted cross-process inputs. Bounds, diagnostic payloads, tokens,
  session IDs, and operation IDs are Schema-decoded and correlated again in main.
- Runtime `error` messages are hints from untrusted frame code and must be bounded/escaped before
  display or model inclusion. A missing `ready`, oversized layout, horizontal overflow, renderer
  disconnect, capture failure, or timeout fails the attempt rather than silently publishing.
- A successful screenshot is not proof of interaction behavior, factual correctness, accessibility,
  or absence of off-screen defects. Factual content is constrained by verified facts/source refs;
  Electron tests exercise selection/focus/progressive disclosure at panel and fullscreen sizes.
- Published source remains inspectable through the existing Source control and always has a readable
  Markdown fallback. No screenshot becomes the artifact itself.

## Bounded implementation breakdown

These are deliberately small follow-up assignments; none depends on preserving the architecture
graph renderer.

1. **Contracts and Pi specialist capability (Sol-sized).** Add bounded domain/RPC data, resolve the
   configured `"Astra"` preset to a full Pi selection and require image input, and add a scoped
   restricted specialist capability behind `src/services/pi` that supports one initial generation,
   at most two replacement-producing feedback turns (compiler/runtime/layout or screenshot), and
   the mandatory final screenshot acceptance turn—at most three feedback turns total—with real
   abort. Prove model resolution, no fallback, limits, and cancellation with deterministic Service
   Layers.
2. **Hidden capture vertical slice (Electron owner).** Add token-correlated readiness/diagnostics
   and main `RenderedWidgetCapture` using a hidden offscreen `BrowserWindow` and
   `webContents.capturePage`. Verify with a real isolated Electron test that the captured PNG contains
   the sandboxed widget, runtime errors and cancellation propagate, resources serialize and clean up,
   and no visible renderer surface or display-media API is used.
3. **Orchestration and atomic publication (Sol-sized).** Implement the main domain coordinator,
   attempt budget, per-artifact rejection/global bound, current-first progress Stream, cleanup, and
   publication through existing storage/pointer/event paths. Test initial success, compile then
   visual revision, exhausted attempts, cancellation at each wait, capture failures, and
   preservation of the prior successful revision using deterministic fakes.
4. **Kit and prototype extraction (Astra-sized, gated).** From two successful structurally different
   examples, publish only demonstrated kit primitives under one compiler allowlist entry. Add
   source-backed benchmark fixtures and named repository visual-capture scenarios; keep benchmark
   capture code out of the production service.
5. **Product wiring and graph cleanup (still prototype-gated).** After prototype review, choose the
   explanatory workflow's exact public operation and wire its artifact UI, callers, tests, and docs.
   Remove obsolete graph-specific APIs and renderer only after the replacement is integrated. Keep
   generic `widgets.present` for other bespoke-widget cases unless a separate product decision
   replaces it; do not treat this work as authorization for collateral removal or add compatibility
   aliases.

## Open decisions and blockers

- **Astra configuration:** the minimal policy can require one uniquely named configured preset
  `"Astra"` now. Before broader release, decide whether application settings should instead store a
  dedicated preset ID; that avoids rename sensitivity while preserving configured-preset semantics.
- **Vision support:** rendered self-critique requires the resolved Astra model to advertise image
  input. If the configured model lacks it, v1 should fail preflight rather than silently omit the
  screenshot or switch models.
- **Capture visibility:** generation review is intentionally invisible. It renders in a main-owned,
  hidden offscreen Electron window with the production `cake-widget:` document inside an opaque-origin
  sandbox iframe; it is not `display:none`, jsdom, or a localhost browser substitute.
- **Acceptance trigger:** deterministic compile/runtime/layout checks are clear, but there is no
  trustworthy automatic visual-quality score. The first production cut should treat specialist
  critique plus those checks as advisory and keep explicit user regeneration/repair available; do
  not invent a numeric quality threshold.
- **Private-session and screenshot retention:** widget sidecars are currently persisted, and Pi
  persists image blocks supplied in prompts into their JSONL messages. Define a bounded retention
  and deletion rule before shipping at scale; this is separate from immutable artifact retention
  and must be disclosed as screenshot retention rather than described as memory-only.
- **Compiled document cleanup:** the current `cake-widget:` registry is an unbounded process Map.
  The operation needs token invalidation on attempt replacement/settlement, and mounted published
  widgets need a scoped/recreatable registration policy. This is security/resource cleanup, not an
  artifact compatibility concern.
