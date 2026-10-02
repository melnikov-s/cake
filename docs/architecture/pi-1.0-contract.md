# Pi 1.0.0 Service contract

Cake pins `@earendil-works/pi-coding-agent` 1.0.0. All ordinary application
imports of Pi packages live beneath `src/services/pi`. `PiLive` provides
`CakeSessionRuntimes`, `PiModels`, and `PiAgentResources`; Cake domain operations and RPC
never expose raw Pi objects.

The deterministic adapter contract exercises these public APIs directly:

- `SettingsManager.inMemory()` and `SessionManager.inMemory()`;
- `DefaultResourceLoader`, inline extension factories, and `reload()`;
- `createAgentSession()` with an in-memory session and no enabled tools;
- `AgentSession.subscribe()`, `bindExtensions()`, `prompt()`, session identity,
  and `dispose()`;
- the public mutable `Agent.streamFunction` plus Pi AI's
  `createAssistantMessageEventStream()` for Cake's abort-aware empty-429 retry
  policy;
- `ExtensionAPI.registerCommand()` and `sendMessage()`;
- `ExtensionCommandContext.ui.confirm()` through Cake's session-bound UI
  adapter;
- `message_update` text deltas and displayed custom `message_end` events at the
  Pi-to-Cake projection boundary.

The foundation test is provider-free and deterministic. It proves scoped
session lifecycle, extension binding, interactive UI routing, and event
normalization without credentials or model cost. Provider-backed streaming uses
the same `CakeSessionRuntimes` implementation in production and remains opt-in in tests.

## Minimal 1.0 upgrade

Cake pins `pi-ai` and `pi-tui` to the same 1.0.0 cohort and requires Node
`>=22.19.0`. Provider stream fixtures use Pi's `normalizeContext()`; Cake's retry
wrapper forwards that normalized transcript unchanged. Queue fixtures honor
Pi's `"queued" | "handled"` return contract.

Provider login supplies Pi's stable installation UUID through `LoginOptions`,
with identity and persistence owned by Pi's global `SettingsManager`. Cake keeps
its boolean quiet-startup control, projecting Pi's `"header"` setting as enabled
without rewriting it on load.

This upgrade does not register the new MCP, codemode, or tool-search factories,
or add virtual-model, image-generation, or classifier UI. Existing session tool
and extension profiles remain unchanged.

### Verification

The minimal upgrade passes typecheck, format check, full lint, desktop/browser
builds, standalone server bundling, 263 focused Pi/adapter unit tests, 19 runtime
integration tests, and four Electron smoke tests (local/remote authentication,
extension UI, durable session/reset and composer typing).

The full unit run still fails the settings-search label assertion (`Cake prompts`
versus `Instructions & prompts`). The slash-command and rate-limit-stop Electron
smokes also fail their existing UI expectations. All three failures were reproduced
with the previous Pi 0.85.1 dependencies; they are not fixed by this upgrade.
No live-provider compatibility sweep was performed.

## Service ownership

- `CakeSessionRuntimes` owns list, inspect, keyed scoped runtime acquisition, session
  operations, runtime commands, session-bound extensions, and observation.
- `PiModels` owns catalog, authentication/availability projection, resolution,
  and bounded non-session completion through Pi's model runtime.
- `PiAgentResources` owns context-dependent skills, prompt templates,
  configured extension sources, and discovery/load diagnostics.
- Pure mapping modules beneath `src/services/pi` normalize Pi values into
  Cake-owned Schemas.

There is no separate `PiExtensions` Service. Extension execution is part of a
live Pi Session Runtime, while discovery information belongs to
`PiAgentResources`.

Pi Session observation reconstructs durable state through Pi from JSONL and
then emits live runtime events. Cake does not read or mutate JSONL directly.

## Special commands

Pi's `/changelog` is an interactive-mode command rather than an
`AgentSession.prompt()` command. `CakeSessionRuntimes` handles it as a local runtime
command: it reads Pi's bundled `CHANGELOG.md` through public `getPackageDir()`,
returns Markdown through the Cake-owned RPC projection, and never adds it to a
Pi Session transcript or sends it to a model.

The extension UI adapter supports Cake's documented primitive React surfaces.
TUI-only methods fail with actionable compatibility diagnostics rather than
false success. See [`s3-pi-compatibility.md`](./s3-pi-compatibility.md).
