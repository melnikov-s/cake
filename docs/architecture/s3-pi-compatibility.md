# S3 Pi ecosystem compatibility contract

Cake loads extensions, tools, providers, commands, skills, prompt templates,
and packages through Pi 0.84.0. `PiSessions`, `PiModels`, and
`PiAgentResources` beneath `src/services/pi` are the only application Services
that read Pi resource and extension types. They normalize discovery and runtime
state into Cake-owned Effect Schemas before Effect RPC.

## State and authority

| State                                                                 | Authority                          | Owner and lifetime                                                                              |
| --------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Loaded skills, prompts, configured extension sources, and diagnostics | Pi resource loader/package manager | `PiAgentResources`; context-dependent snapshot, reloaded through Pi                             |
| Runtime commands, tools, extension status, and title                  | Active Pi Extension runtime        | Scoped `PiSessions` handle and Cake Session projection                                          |
| Notifications and compatibility warnings                              | Active Pi Extension runtime        | Focused renderer Store projection; never persisted                                              |
| Dialog responses                                                      | User                               | Correlated RPC/runtime operation; interruption, timeout, or Scope disposal settles cancellation |
| Composer draft                                                        | Cake renderer                      | Authoritative composer Store; supported extension editor intents use the same mutation path     |

No compatibility catalog or extension UI state is written into Pi JSONL or
Cake application metadata. Reopening a Pi Session Runtime reconstructs it
through Pi.

## Session-bound extensions

There is no public `PiExtensions` Service. When `PiSessions.acquire` opens a
runtime, it loads the applicable Pi Extensions according to the Cake Session's
semantic capability profile, binds Cake's UI adapter, and exposes runtime
commands and projected events through the session handle. Reload is an explicit
session operation.

`PiAgentResources` reports configured sources and load diagnostics but does not
claim that an extension's executable commands are available before a runtime
loads them.

## Supported primitive UI

Cake adapts `select`, `confirm`, `input`, multiline `editor`, `notify`,
`setStatus`, `setTitle`, `setEditorText`, and `pasteToEditor`. Dialog abort
signals and timeouts are enforced by the scoped session runtime.

## Explicit degradation

Terminal Component factories and terminal-owned behavior cannot be translated
safely or truthfully. Calls such as `custom`, `setWidget`, custom header,
footer, editor and autocomplete providers, raw terminal input, Pi TUI themes,
and terminal working-indicator customization create a deduplicated visible
compatibility diagnostic. Methods with result contracts return cancellation or
failure after recording it; they never report false success.

## Isolation and fixtures

Every update identifies its Pi Session. Renderer Stores reject stale targets
and clear session-bound extension UI before replacement. Releasing a
`PiSessionHandle` cancels pending dialogs and disposes its runtime when the
final acquisition releases it.

The compatibility suite loads a real local Pi package containing a skill,
prompt, extension command, custom provider, and MCP-shaped headless tool. It
also loads Pi's shipped subagent example unchanged. Pi 0.84.0 does not ship an
MCP extension fixture, so the suite exercises the relevant headless tool shape
without claiming compatibility with an unavailable concrete package.
