# Interactive explanations: bounded benchmarks

These are source-backed briefs for the first prototype in
[`interactive-explanations-plan.md`](./interactive-explanations-plan.md). They
are evaluation inputs, not a production contract or a layout specification.
The machine-readable copy is
[`tests/fixtures/interactive-explanations.json`](../../tests/fixtures/interactive-explanations.json).

A specialist should choose the composition that best explains the brief and
produce sandboxed React/SVG from the supplied facts. A narrative, layered
view, annotated cards, timeline, radial view, or graph may all be appropriate;
no graph DSL, diagram library, Mermaid, pixel coordinates, or fixed layout is
required. Keep interpretation visibly separate from confirmed facts, and use
workspace-relative source references. Do not add a Cake web server, remote
browser, or other architecture not established by the current source.

## Brief 1: one prompt through Cake and back

**Audience:** A new Cake contributor who understands React but not the
Electron/Pi seam.

**Goal:** Make one ordinary Project Session prompt traceable from the composer
to Pi and back to the visible transcript, including where each representation
changes.

**Brief to the specialist:** Explain the request and update loop, emphasizing
what the user can observe and which layer owns each transition. Choose a
composition that makes the outbound command and inbound live projection easy
to follow without implying that the renderer talks to Pi directly.

**Confirmed facts**

- `Chat` renders a supplied `ChatStore`; `ConversationSessionStore.chatStore`
  wires submit to its `ConversationComposerStore` child.
  Sources: `src/renderer/components/chat.tsx#Chat`,
  `src/renderer/stores/ConversationSessionStore.ts#ConversationSessionStore.chatStore`.
- `ConversationSessionStore.deliver` selects the Promise `Client` command
  (`sessionChats.prompt`, or `sessionChats.steer` for an explicit steer).
  `makeClient` runs the Effect operation through the private renderer `Runtime`
  and forwards an optional `AbortSignal`.
  Sources: `src/renderer/stores/ConversationSessionStore.ts#ConversationSessionStore.deliver`,
  `src/renderer/client/ClientLive.ts#makeClient`,
  `src/renderer/client/Client.ts#Client`.
- `CakeIpcClientLive` maps that command to the shared Effect RPC operation;
  `preload.ts` exposes only a frozen `window.cake.rpc`, and
  `makeElectronRpcClientProtocol` sends transport messages through it.
  Sources: `src/ipc/client/CakeIpcClient.ts#CakeIpcClientLive`,
  `src/preload/preload.ts#rpc`,
  `src/ipc/transport/ElectronRpcClientProtocol.ts#makeElectronRpcClientProtocol`.
- `ElectronRpcServerProtocolLive` parses the request received on
  `cake:rpc:request` and adds trusted renderer-connection/correlation metadata.
  `sessionChatHandlers` binds the connection and calls the domain
  `sessionChats.deliver` operation.
  Sources: `src/ipc/transport/ElectronRpcServerProtocol.ts#ElectronRpcServerProtocolLive`,
  `src/ipc/server/SessionChatHandlers.ts#sessionChatHandlers`,
  `src/domain/conversations/sessionChats.ts#deliver`.
- The shared domain `conversations.deliver` dispatches to a scoped
  `CakeSessionHandle`; `makeCakeSessionRuntimesLayer`'s `startTurn` eventually calls the
  live runtime's `prompt`.
  Sources: `src/domain/conversations/conversations.ts#deliver`,
  `src/services/pi/CakeSessionRuntimes.ts#makeCakeSessionRuntimesLayer`,
  `src/services/pi/CakeSessionRuntimes.ts#CakeSessionHandle.prompt`.
- `createCakeSessionRuntime` creates the Cake adapter around Pi's
  `createAgentSession` and subscribes to Pi events. On the return path,
  `ProjectSessions.observe` uses `conversations.observe`; the renderer model
  observer applies the resulting snapshots/events with
  `applyProjectSessionUpdate`.
  Sources: `src/services/pi/runtime/cake-session-runtime.ts#createCakeSessionRuntime`,
  `src/domain/project-sessions/projectSessionOperations.ts#observe`,
  `src/domain/conversations/conversations.ts#observe`,
  `src/renderer/observers/models.ts#createModelObserver`,
  `src/renderer/reducers/ConversationReducer.ts#applyProjectSessionUpdate`.

**Relationships that must remain true**

- Renderer UI uses `Client` and the validated RPC path; it does not import Pi,
  Electron main implementations, or filesystem capabilities.
- Main RPC handlers adapt to Cake domain operations; the domain chooses and
  acquires the Pi capability rather than the renderer assembling a runtime.
- Pi remains the transcript/runtime authority. Renderer Models and optimistic
  composer state are projections or temporary presentation state, not a second
  transcript.
- A live observation starts with a current snapshot and then ordered events;
  a reconnect does not invent transcript history.

**Primary vs optional**

- **Primary:** composer submit → Client → preload/RPC → main handler/domain →
  Pi turn, then Pi event → domain projection → renderer Model/Chat.
- **Optional detail:** optimistic user-part rendering, turn-accepted/settled
  receipts, queue versus steer, cancellation, and correlation IDs. Show these
  only if they clarify the main loop.

**User-requested revision scenario:** “Keep the end-to-end story, but select
one turn and reveal its accepted, streaming, and settled states. Make the
optimistic composer message visibly renderer-local and keep the Pi transcript
authority explicit.”

## Brief 2: process and authority boundaries

**Audience:** A security-minded maintainer or reviewer deciding whether a
visual explanation respects Cake's ownership model.

**Goal:** Distinguish renderer, preload, main, Pi, Cake domain/storage, and
sandboxed generated-code boundaries without inventing a web/server tier.

**Brief to the specialist:** Explain both privilege and authority. Show where
code runs, where data is validated, and which system can reconstruct each
durable fact after restart. Make projections look derived, not authoritative.
Use a clear boundary treatment of your choice; do not turn every boundary into
a node-and-edge map.

**Confirmed facts**

- `main.ts` creates the process `ManagedRuntime` from `makeMainLive` and starts
  `MainApplication`; `makeMainLive` composes storage, native services, Pi, session
  workflows, background workers, and the RPC server in Electron main.
  Sources: `src/main/main.ts#mainRuntime`,
  `src/main/MainLive.ts#makeMainLive`,
  `src/main/MainApplication.ts#MainApplication`.
- Renderer bootstrap creates one window `Runtime`, `Client`, `RootProjection`,
  and mounted Store tree, then attaches model/event observers and window-state
  persistence. `makeRuntime` keeps its `ManagedRuntime` private.
  Sources: `src/renderer/main.ts#bootstrap`,
  `src/renderer/runtime.ts#makeRuntime`,
  `src/renderer/client/ClientLive.ts#makeClient`,
  `src/renderer/models/RootProjection.ts#RootProjection`.
- The preload module exposes only the frozen `rpc` transport through
  `contextBridge`; it contains no Cake business logic or general Electron API.
  Source: `src/preload/preload.ts#rpc`.
- Both RPC transport sides decode untrusted messages. The main server protocol
  routes responses to the originating `webContents`, while
  `RendererConnectionMiddlewareLive` supplies trusted connection and correlation
  context to handlers.
  Sources: `src/ipc/transport/ElectronRpcClientProtocol.ts#makeElectronRpcClientProtocol`,
  `src/ipc/transport/ElectronRpcServerProtocol.ts#ElectronRpcServerProtocolLive`,
  `src/ipc/protocol/RendererConnectionMiddleware.ts#RendererConnectionMiddlewareLive`.
- The architecture source-of-truth table assigns Project Session transcripts,
  tool history, branching, and compaction to Pi; Projects, workflow metadata,
  and artifacts to Cake; and renderer Models to validated projections.
  Source: `docs/architecture/cake-architecture.md#Sources of truth`.
- Generated widgets are data at the Cake artifact boundary: `compileInlineWidget`
  restricts source size/imports, `handleInlineWidgetScheme` serves a CSP-limited
  document, and `WidgetArtifact` runs it in an `allow-scripts` iframe and checks
  its tokenized messages.
  Sources: `src/services/widgets/inline-widget-service.ts#compileInlineWidget`,
  `src/services/widgets/inline-widget-protocol.ts#handleInlineWidgetScheme`,
  `src/renderer/components/widget-artifact.tsx#WidgetArtifact`.

**Relationships that must remain true**

- Privileged filesystem, native Electron, storage, Cake domain, and Pi work
  remain in main; the renderer stays sandboxed and reaches them through the
  validated bridge.
- Preload is mechanical transport, not a business-logic or authority layer.
- Each durable fact has one authority: Pi for transcript/runtime facts, Cake
  for application/artifact metadata, and renderer Models only for derived state.
- Model-generated React/SVG is never executed with Cake, Node, Electron,
  filesystem, parent-DOM, or arbitrary network/API privileges; the CSP's
  explicit media allowances are the only remote-resource exception.

**Primary vs optional**

- **Primary:** Electron process strips, the narrow preload bridge, RPC
  validation, and the Pi/Cake/renderer authority split.
- **Optional detail:** renderer runtime scopes, connection correlation,
  content-addressed artifact storage, widget CSP/token messages, and native VS
  Code or terminal services.

**User-requested revision scenario:** “Make the renderer Model visibly a
projection rather than a database. Move widget CSP and token details into an
optional security disclosure, but retain the fact that the iframe has no Cake,
Node, Electron, filesystem, parent, or arbitrary network/API access (apart from
the documented media allowances).”

## Brief 3: dense delegated-widget dependency case

**Audience:** A specialist implementing an interactive explanation and a
reviewer checking that its generation path remains faithful to existing Cake
seams.

**Goal:** Explain the dense path from a primary Pi request for a visual
explanation through isolated generation, compile/repair, artifact persistence,
and sandboxed display. This is a benchmark grounded in the existing delegated
widget path; it is not a claim that the new automatic workflow is shipped.

**Brief to the specialist:** Communicate why the visual is delegated, what data
crosses each seam, and how compile failure is handled. Keep the supplied brief,
data, fallback, and security constraints primary. Choose a composition suited
to the dependency density; a graph is allowed but not required, and no source
code or coordinates need be exposed in the visual.

**Confirmed facts**

- The `widgets.present` definition in `createCakeArtifactOperations` accepts a
  bounded brief, optional data, and Markdown fallback; it calls
  `generateInlineWidget` with the current model and turn signal, then persists a
  `cake.artifact/v1` widget and appends a Pi artifact pointer.
  Sources: `src/services/pi/runtime/cake-artifact-operations.ts#createCakeArtifactOperations`,
  `src/ipc/artifact-contract.ts#parseArtifactInput`.
- `ProjectSessionIntegrationHost.generateInlineWidget` runs generation,
  extracts exactly one `cake-react` result, compile-checks it, and on a compile
  failure runs one repair with the diagnostic/context before compiling the
  repaired source. `persistArtifact` emits `artifact-updated` after repository
  upsert.
  Source: `src/services/pi/ProjectSessionIntegrationHost.ts#ProjectSessionIntegrationHost.generateInlineWidget`.
- `runInlineWidgetGeneration` and `runInlineWidgetRepair` use
  `runIsolatedSession`. That runner creates a Pi `ModelRuntime` and a restricted
  resource loader; widget generation uses `projectTrusted: false` and
  `noTools: "all"`, with no extensions, skills, prompt templates, themes, or
  context files.
  Sources: `src/services/pi/runtime/sidecar-runtime.ts#runInlineWidgetGeneration`,
  `src/services/pi/runtime/sidecar-runtime.ts#runInlineWidgetRepair`,
  `src/services/pi/runtime/isolated-session-runner.ts#runIsolatedSession`.
- `compileInlineWidget` enforces a 1 MiB source limit and allows React plus the
  approved `d3` modules only. It emits a tokenized document shell;
  `inlineWidgetContentSecurityPolicy` defaults to no sources and permits only the
  explicit inline script/style and data/HTTPS media cases.
  Sources: `src/services/widgets/inline-widget-service.ts#compileInlineWidget`,
  `src/services/widgets/inline-widget-service.ts#widgetModulePlugin`,
  `src/services/widgets/inline-widget-protocol.ts#inlineWidgetContentSecurityPolicy`.
- `WidgetArtifact` invokes the window-owned `InlineWidgetStore` to compile and
  repair, renders the result in `sandbox="allow-scripts"`, validates tokenized
  `postMessage` events, and can place the same widget in `FullscreenSurface`.
  Sources: `src/renderer/components/widget-artifact.tsx#WidgetArtifact`,
  `src/renderer/stores/InlineWidgetStore.ts#InlineWidgetStore.repair`,
  `src/renderer/components/fullscreen-surface.tsx#FullscreenSurface`.
- `ArtifactRepository.upsert` validates artifact input, content-addresses the
  serialized payload, writes immutable blobs, and requires revisions to advance
  one step. Current widget repair state is renderer-local; retaining the prior
  successful published artifact after a failed revision is a production-phase
  requirement, not a prototype result.
  Sources: `src/services/storage/ArtifactStorageLive.ts#ArtifactRepository.upsert`,
  `src/ipc/artifact-contract.ts#artifactRecordSchema`.

**Relationships that must remain true**

- The primary Pi session supplies an explanation brief/data/fallback, not
  privileged generated code; the isolated specialist returns self-contained
  React/SVG that is compile-checked before persistence.
- The repair input may include source and diagnostics as untrusted data; repair
  must not widen tools, imports, filesystem access, frame privileges, or
  arbitrary network/API access.
- The artifact repository owns published payload/revision metadata; Pi owns the
  transcript pointer; the iframe owns only its local presentation runtime.
- A failed generation or revision must not be presented as a successful
  published artifact. Previous-success retention is explicitly deferred to the
  production phase until the workflow has an atomic publication policy.

**Primary vs optional**

- **Primary:** brief/data/fallback → isolated Pi specialist → compile/repair →
  Cake artifact record/pointer → sandboxed widget and its useful interaction.
- **Optional detail:** exact token protocol, approved D3 submodules, content
  hashing, generation-session ID, source disclosure, and fullscreen framing.

**User-requested revision scenario:** “Keep the explanation's main composition,
but make the dense compile/repair boundary inspectable: show what failed, let
me understand why the repaired source is still sandboxed, and preserve the
previous successful published revision if the requested revision fails.” The
last clause is marked production-phase and must not be reported as a passing
prototype behavior unless the implementation actually provides it.

## Evaluation checklist

Run the same brief with the same confirmed facts and fallback. Record source
references and qualitative observations; do not publish captures, scores, or
numeric pass results before a runnable prototype exists.

### View matrix

- [ ] Normal artifact panel is readable without zooming.
- [ ] Fullscreen view has a deliberate reflow rather than a stretched panel.
- [ ] Normal panel and fullscreen are checked in both `light` and `dark` themes.
- [ ] A narrow panel/viewport is exercised in addition to the desktop capture;
      no horizontal scroll is required.

### Content and interaction

- [ ] Initial viewport communicates the goal and the primary relationship before
      interaction or scrolling.
- [ ] Primary labels/facts are legible; optional detail is discoverable without
      competing with the main explanation.
- [ ] At least one interaction materially clarifies the explanation (selection,
      focus, progressive disclosure, filtering, or an equivalent chosen by the
      specialist), rather than being decorative.
- [ ] Every interactive control is keyboard reachable, has an accessible name,
      and exposes visible focus; fullscreen can be entered and exited with the
      existing surface behavior.
- [ ] No primary label overlaps, clips, disappears, or becomes unreadable in
      either theme or view.
- [ ] Claims match current source symbols and paths; interpretation is marked,
      and no web/server architecture is implied without evidence.
- [ ] Readable fallback preserves the core explanation when the interactive
      surface is unavailable.
- [ ] Generated output remains inside the documented sandbox and uses only the
      provided facts/data.
- [ ] **Failed-revision retention — production phase:** after a successful
      published revision, a rejected/failed requested revision leaves that prior
      revision visible and addressable. Do not score this for the first prototype
      unless the prototype explicitly implements and verifies the policy.

## Capture harness

The registry-driven harness includes a deterministic React widget scenario for
the request explanation. New benchmark scenarios should follow that widget
pattern:

1. Add a `VisualCaptureScenario` object in
   `scripts/visual-capture/scenarios.ts`, implementing its `name`,
   `description`, `states`, `seed`, `prepare`, and `region`, then append it to
   `visualCaptureScenarios`.
2. In `seed`, follow the existing widget scenario pattern:
   create the isolated `window-state.json`, `state/application.json`, and
   deterministic Pi JSONL under the temporary `CAKE_HOME`/project paths; seed
   a widget artifact record/blob only after the prototype's artifact shape is
   stable. Keep all data local and deterministic.
3. In `prepare`, wait for the real artifact button and
   `[data-artifact-kind="widget"]` surface, then wait for the widget's iframe
   readiness/height. Give the named interaction state a real accessible action
   (for example, the prototype's selection/disclosure), and use the existing
   fullscreen button plus `role="dialog"` for the fullscreen state. Do not
   encode an arbitrary selector/action language.
4. In `region`, capture the prototype's artifact surface for normal panel and
   the fullscreen dialog for fullscreen. The harness's `capture.ts` already
   launches compiled Electron with isolated `CAKE_HOME` and user data, sets
   viewport dimensions, invokes `prepare`, and emits the stable
   `VISUAL_CAPTURE_RESULT` record.
5. Exercise both themes with the documented CLI controls, for example after
   registration:

   ```text
   pnpm visual:capture interactive-explanation-widget --state default --theme light
   pnpm visual:capture interactive-explanation-widget --state default --theme dark
   pnpm visual:capture interactive-explanation-widget --state fullscreen --theme light
   pnpm visual:capture interactive-explanation-widget --state fullscreen --theme dark
   ```

   Use `--no-build` only after an explicit `pnpm build`; keep captures in the
   ignored `.visual-captures/` directory unless a reviewed baseline is
   intentionally requested. No capture or result is claimed by this benchmark.
