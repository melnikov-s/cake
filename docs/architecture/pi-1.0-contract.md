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
replacement-extension rules remain effective. Cake Chat runs on Pi Durable, where
those extensions cannot bind, so it has its own small `mcp` tool
(`src/services/pi-durable/cake-chat-mcp.ts`) over the same servers: the agent
directory's `mcp.json` plus servers its extensions register (such as the Tool
Gateway). It supports header, environment and `!command` credentials but not
OAuth sign-in.

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

Cake now pins the regular-Pi and Durable packages (including Chord and both
pi-ai import surfaces) to the 1.4.0 cohort. Pi restores the recorded active tool
loadout on resume when Cake has not supplied an explicit selection. Newly
registered extension tools retain Pi's default-active policy; opt-in tools remain
inactive. Cake does not maintain a compensating tool-state cache. Nested script
activity currently uses the existing flat tool projection; grouped nested
presentation remains separate work.

Pi owns recovery edits for output-truncated attempts, including omission of
paired tool results, and provider prompt-cache declaration ordering. Cake keeps
forwarding Pi's normalized context and its existing cache-lineage request options.
Extension-triggered recovery runs now pass through `before_agent_start`, so Cake's
prompt transformations also apply to those runs. Native codemode worker admission
and concurrency limits remain entirely Pi-owned; Cake adds no worker queue or
changes to process/global settings.

For regular-Pi compaction, `reserveTokens` controls the trigger threshold, not a
summary output cap. Compaction and branch summaries use Pi's model output defaults
(subject to remaining context capacity). Cake delegates both and does not impose
a replacement cap. The Durable coordinator's separate normal-request admission
reserve is unchanged.

Durable 1.4 requires explicit document checkpoint policies; Cake's documents keep
ordinary mutations as deltas (`checkpointWhen: () => false`). Its tool adapter
returns `output` rather than the removed `content` result field. Display-only
writes persist immediately while a conversation is busy rather than remaining in
its input queue. Opening Durable SQLite storage migrates it to schema version 2;
back up coordinator databases before deployment because Pi 1.3 and earlier cannot
open the migrated databases.

Cake's standalone workflow sandbox uses Pi's deterministic execution API with a
fixed clock and seed. Lexical Date/Math helpers preserve the workflow API's clock
restrictions without attempting to mutate Pi's frozen VM intrinsics. Per-run host
calls are aborted when the script ends, including unawaited calls.

Use MCP commands in an established conversation. Pi does not persist
command-only input in a new session, and Cake's staged-chat promotion currently
releases that transient runtime, so a follow-up command in that draft can fail
with "has not been assembled". This is a separate draft-lifecycle gap; MCP does
not synthesize user or assistant entries to force persistence.

## Native image presentation

Result images—codemode `image()` output and widget/artifact initial-state
previews—appear directly in the shared Chat transcript beneath their work-log
group, even when the log is collapsed. Script, arguments and text output remain
inspectable in the log; opening it does not duplicate the images. Inspection
images from every other tool (image file reads, attachment reads, browser
screenshots) render only inside their expanded tool entry, never as a separate transcript
item. An image read shows only the image, omitting Pi's "Read image file" text. The model receives the same image
blocks either way. Fullscreen preview uses the existing shared image surface.
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

## Agent-requested targeted compaction

`sessions.compact` and `sessions.compact-batch` execute in backend domain control,
including permanent Project Chat. They use Cake identity resolution, per-project
caller scope and ProjectAccess authorization before acquiring the target's shared
regular-Pi runtime. Bulk targets are bounded to 100, deduplicated by canonical
identity within the call, and return ordered outcomes even after individual failures.
The assistant can collect to-do associations through existing `todos.list/read`;
to-do completion never schedules compaction or changes session resolution.

The regular-Pi adapter exposes `compactIfIdle` separately from existing
self-compaction. Pi's public `AgentSession.compact(customInstructions)` aborts
first, so Cake must reject active/preparing/queued/compacting targets before calling
it. The turn controller reserves the existing command/held-input lane synchronously,
holds new normal input until compaction settles, and exposes maintenance activity to
runtime lifecycle checks. The service also checks accepted turns before dispatch.
Once started, the operation is uninterruptible at the Effect Promise boundary,
retaining the scoped runtime until Pi completes; stopping the caller cannot dispose
a runtime underneath an in-flight compaction. This is not a queued request receipt.

Pi persists the compaction and keeps original transcript entries. Only its exact
already-compacted and too-small errors become `unchanged`; provider failures and
extension cancellation remain failures. Retries are not automatic or durably
deduplicated across calls: unchanged history is a Pi no-op; later history can be
compacted again. Existing `context.compact` and explicit queued slash commands
retain their behavior.

Maintenance acquisition may load resolved history in an available checkout, but
skips legacy child-resolution migration and never restores a retired worktree.
Drafts and retired/missing checkouts return unavailable. No direct JSONL rewrites,
history deletion, session resolution, or to-do mutations are involved.

## Special commands

Pi's `/changelog` is an interactive-mode command rather than an
`AgentSession.prompt()` command. `CakeSessionRuntimes` handles it as a local runtime
command: it reads Pi's bundled `CHANGELOG.md` through public `getPackageDir()`,
returns Markdown through the Cake-owned RPC projection, and never adds it to a
Pi Session transcript or sends it to a model.

The extension UI adapter supports Cake's documented primitive React surfaces.
TUI-only methods fail with actionable compatibility diagnostics rather than
false success. See [`s3-pi-compatibility.md`](./s3-pi-compatibility.md).
