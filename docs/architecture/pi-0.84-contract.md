# Pi 0.84.0 Service contract

Cake pins `@earendil-works/pi-coding-agent` 0.84.0. All ordinary application
imports of Pi packages live beneath `src/services/pi`. `PiLive` provides
`PiSessions`, `PiModels`, and `PiAgentResources`; Cake domain operations and RPC
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
the same `PiSessions` implementation in production and remains opt-in in tests.

## Service ownership

- `PiSessions` owns list, inspect, keyed scoped runtime acquisition, session
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
`AgentSession.prompt()` command. `PiSessions` handles it as a local runtime
command: it reads Pi's bundled `CHANGELOG.md` through public `getPackageDir()`,
returns Markdown through the Cake-owned RPC projection, and never adds it to a
Pi Session transcript or sends it to a model.

The extension UI adapter supports Cake's documented primitive React surfaces.
TUI-only methods fail with actionable compatibility diagnostics rather than
false success. See [`s3-pi-compatibility.md`](./s3-pi-compatibility.md).
