# Pi 1.0.0 Service contract

This is the regular coding-agent contract: Cake pins
`@earendil-works/pi-coding-agent` 1.0.0 and keeps its ordinary application imports
beneath `src/services/pi`. `PiLive` provides `CakeSessionRuntimes`, `PiModels`, and
`PiAgentResources`; Cake domain operations and RPC never expose raw Pi objects.
The permanent coordinator intentionally uses the separate
[Pi Durable storage contract](./cake-storage.md#permanent-cake-chat) through
`src/services/pi-durable`. JSONL and `AgentSession` guarantees here do not describe
that coordinator's SQLite storage or recovery.

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

The initial compatibility-only upgrade did not register MCP, codemode, or
tool-search factories, or add virtual-model, image-generation, or classifier UI.
Native MCP was added separately as described below.

### Recorded upgrade verification

These results were recorded for the minimal upgrade, not later checkouts.

The minimal upgrade passed typecheck, format check, full lint, desktop/browser
builds, standalone server bundling, 263 focused Pi/adapter unit tests, 19 runtime
integration tests, and four Electron smoke tests (local/remote authentication,
extension UI, durable session/reset and composer typing).

That full unit run failed the settings-search label assertion (`Cake prompts`
versus `Instructions & prompts`). The slash-command and rate-limit-stop Electron
smokes also failed their existing UI expectations. All three failures were reproduced
with the previous Pi 0.85.1 dependencies and were not fixed by that upgrade.
No live-provider compatibility sweep was performed.

## Native MCP integration

Ordinary primary Project Sessions without an explicit tool allowlist load Pi's
named, builtin, replaceable `mcp`, `codemode`, and `tool-search` extensions.
Cake Chat, auxiliary Discussion/Subagent runtimes, and explicit tool allowlists
(including empty lists) do not receive these factories. Pi's builtin disable and
replacement-extension rules remain effective.

Backend bootstrap delegates the agent home to Pi's `getAgentDir()` and never
sets `PI_CODING_AGENT_DIR`. Cake and terminal Pi share configuration, resources
and primary project transcripts. Eligible runtime construction rejects a root
that disagrees with Pi's process-level home, rather than reading another
configuration or credential directory. Pi owns personal
`mcp.json`, `mcp-auth.json`, and `mcp.log` there; project `.pi/mcp.json` loads only
with project trust and overrides same-name personal servers.

Explicit tool selections are preserved. Backend settings bootstrap seeds a missing
Pi global `defaultTools` with `["+codemode"]`; resetting the Cake control restores
that selection. Codemode is therefore enabled by default in eligible Project
Sessions, with `mode: "on"` (ordinary declarations remain visible). Explicit empty
lists, `-codemode`, project overrides and disabled extensions remain authoritative.
Tool search still begins inactive; server exposure and Pi settings activate it.
MCP auto-activation separately respects `autoEnableCodemode: false`.

Global settings reload also refreshes the permanent Durable Cake Chat's Pi settings
and coordinator instructions without replacing its engine, inbox or history. It is
not a Project Session edit; the coordinator retains its restricted tool registry. MCP calls use Pi's tool/permission pipeline, including
script-issued calls, cancellation, resources, and tool-result conversion.

`/mcp`, `/mcp login`, `/mcp logout`, and `/mcp reconnect` use existing conversation
commands, notifications, and extension dialogs. Cake does not parse status text
into a connection database. Authorization URLs are shown for manual opening;
Cake suppresses Pi's backend browser launcher. The existing text dialog accepts
pasted redirect URLs and cancellation, including for remote backends. There is
no dedicated MCP configuration screen or automatic native URL-opening operation.

Final runtime disposal aborts active work, awaits any in-flight reload, then
awaits `session_shutdown` with reason `quit` before Pi invalidates contexts.
Repeated disposal shares one Promise. Reload dispatches its own shutdown through
Pi, without a duplicate Cake dispatch.

Pi 1.0's SDK passes an explicit initial tool loadout when constructing a resumed
session, overriding its transcript-based declaration restoration. Deferred tools
remain searchable after resume, but must be rediscovered. Cake does not maintain
a compensating tool-state cache. Nested script activity currently uses the
existing flat tool projection; grouped nested presentation remains separate work.

Use MCP commands in an established conversation. Pi does not persist
command-only input in a new session, and Cake's staged-chat promotion currently
releases that transient runtime, so a follow-up command in that draft can fail
with "has not been assembled". This is a separate draft-lifecycle gap; MCP does
not synthesize user or assistant entries to force persistence.

## Native image presentation

Native image blocks in ordinary tool results appear directly in the shared Chat
transcript beneath their work-log group, even when the log is collapsed. Script,
arguments and text output remain inspectable in the log; opening it does not
duplicate the images. Fullscreen preview uses the existing shared image surface.
This is a renderer presentation of Pi-owned tool output, retaining the original
part identity for selection and replay—not a second transcript or an automatic
workspace save.

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
