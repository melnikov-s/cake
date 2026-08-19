# S3 Pi ecosystem compatibility contract

Cake continues to load extensions, tools, providers, commands, skills, prompt
templates, and packages through Pi 0.84.0. The focused `src/agent` adapter layer is the only
application module that reads Pi resource and extension types. It normalizes
discovery into Cake's bounded `CompatibilityCatalog` before data crosses the
preload boundary.

## State and authority

| State                                    | Authority                                              | Owner and lifetime                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Loaded resources and load diagnostics    | Pi `DefaultResourceLoader` and `DefaultPackageManager` | Project session snapshot; renderer child Models are a read-only projection                                             |
| Extension status and title               | Active Pi extension runtime                            | Focused extension-UI Store projection, cleared before session/workspace replacement                                    |
| Notifications and compatibility warnings | Active Pi extension runtime                            | Focused extension-UI Store, bounded to the active session and never persisted                                          |
| Dialog responses                         | User                                                   | Correlated main-process operation; aborted, timed out, or disposed requests resolve as cancellation                    |
| Composer draft                           | Cake window                                            | Chat/composer Store; extension `setEditorText` and `pasteToEditor` enter through the same authoritative draft mutation |

No compatibility catalog or extension UI state is written into Pi JSONL or
Cake application metadata. Reopening a live runtime reconstructs it from Pi.

## Supported primitive UI

Cake adapts `select`, `confirm`, `input`, multiline `editor`, `notify`,
`setStatus`, `setTitle`, `setEditorText`, and `pasteToEditor`. Dialog abort
signals and timeouts are enforced in the workspace driver.

## Explicit degradation

Terminal Component factories and terminal-owned behavior cannot be translated
safely or truthfully. Calls such as `custom`, `setWidget`, custom header,
footer, editor and autocomplete providers, raw terminal input, Pi TUI themes,
and terminal working-indicator customization create a deduplicated, visible
compatibility diagnostic. Methods with result contracts return cancellation or
failure after recording the diagnostic; they do not report false success.

## Isolation and fixtures

Every event carries a Pi session ID. Renderer Stores reject events for stale
sessions and clear all extension UI as soon as replacement begins. Driver
disposal cancels pending dialogs and disposes every session runtime.

The compatibility suite loads a real local Pi package containing a skill,
prompt, extension command, custom provider, and MCP-shaped headless tool. It
also loads Pi's shipped subagent example unchanged. Pi 0.84.0 does not ship an
MCP extension fixture, so the suite exercises MCP's relevant headless tool
shape without claiming compatibility with an unavailable concrete package.
