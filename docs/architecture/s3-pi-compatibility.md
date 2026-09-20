# S3 Pi ecosystem compatibility contract

Cake loads extensions, tools, providers, commands, skills, prompt templates,
and packages through Pi 0.85.1. `CakeSessionRuntimes`, `PiModels`, and
`PiAgentResources` beneath `src/services/pi` are the only application Services
that read Pi resource and extension types. They normalize discovery and runtime
state into Cake-owned Effect Schemas before Effect RPC.

## State and authority

| State                                                                 | Authority                          | Owner and lifetime                                                                              |
| --------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Loaded skills, prompts, configured extension sources, and diagnostics | Pi resource loader/package manager | `PiAgentResources`; context-dependent snapshot, reloaded through Pi                             |
| Runtime commands, tools, extension status, and title                  | Active Pi Extension runtime        | Scoped `CakeSessionHandle` and Cake Session projection                                          |
| Notifications and compatibility warnings                              | Active Pi Extension runtime        | Focused renderer Store projection; never persisted                                              |
| Dialog responses                                                      | User                               | Correlated RPC/runtime operation; interruption, timeout, or Scope disposal settles cancellation |
| Companion manifest and module                                         | Installed Pi extension package     | Discovered and compiled by the scoped Pi runtime; never copied into Cake persistence            |
| Companion state                                                       | Active Pi Extension runtime        | Published over Pi's event bus and projected with the owning Cake Session                        |
| Composer draft                                                        | Cake renderer                      | Authoritative composer Store; supported extension editor intents use the same mutation path     |

No compatibility catalog, companion state, or extension UI state is written
into Pi JSONL or Cake application metadata. Reopening a Pi Session Runtime
reconstructs it through Pi.

## Session-bound extensions

There is no public `PiExtensions` Service. When `CakeSessionRuntimes.acquire`
opens a `CakeSessionRuntime` around one Pi Session Runtime, it loads the
applicable Pi Extensions according to the one Cake Session's semantic capability
profile, binds Cake's UI adapter, and exposes runtime commands and projected
events through the `CakeSessionHandle`. Reload is an explicit
session operation.

`PiAgentResources` reports configured sources and load diagnostics but does not
claim that an extension's executable commands are available before a runtime
loads them.

## Supported primitive UI

Cake adapts `select`, `confirm`, `input`, multiline `editor`, `notify`,
`setStatus`, `setTitle`, `setEditorText`, and `pasteToEditor`. Dialog abort
signals and timeouts are enforced by the scoped session runtime.

## Trusted React companions

An installed Pi package may provide an optional Cake companion for Project Sessions in
`package.json`:

```json
{
  "pi": { "extensions": ["extensions/plan.ts"] },
  "cake": {
    "companions": [
      {
        "id": "plan-mode",
        "extension": "extensions/plan.ts",
        "entry": "cake/plan-mode.tsx",
        "slot": "composer.above",
        "actions": ["exit"]
      }
    ]
  }
}
```

The companion entry default-exports one React component. Cake main bundles it
for the browser, supplies Cake's existing React instance, and serves it over the
private `cake-extension:` protocol. The sandboxed renderer loads it into the
named slot with `{ state, dispatch, ui }` props. The initial contract exposes
only `composer.above` and the shared `Button` and `Callout` primitives. Slots augment Cake's
authoritative `Chat`; they do not replace its transcript or composer.

The Pi extension publishes JSON state using its standard event bus:

```ts
pi.events.emit("cake:companion:state", { id: "plan-mode", state: { active: true } });
pi.events.on("cake:companion:action", (event) => {
  // event is { id, action, value }; validate extension-owned values before use.
});
```

Cake validates the cross-process state and action envelope and rejects actions
not declared by the manifest. Companion state is transient and is rebuilt by
the extension on `session_start`. Reload recompiles the companion and
reconstructs state through the same event path.

This initial companion host is Project-Session-only; Cake Chat and auxiliary
runtimes do not compile or advertise companion modules.

Companions are trusted installed extension code, not model-presented widgets.
They run as browser code in Cake's sandboxed renderer and therefore have no Node
or Electron globals, but they can inspect or interfere with Cake's DOM and
browser behavior. Installing a global package or trusting a project-local
package is the trust decision for both its Pi runtime and declared companion.
Each contribution has an error boundary so one broken companion does not crash
the renderer.

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
`CakeSessionHandle` cancels pending dialogs and disposes its runtime when the
final acquisition releases it.

The compatibility suite loads a real local Pi package containing a skill,
prompt, extension command, custom provider, and MCP-shaped headless tool. It
also loads Pi's shipped subagent example unchanged. Pi 0.85.1 does not ship an
MCP extension fixture, so the suite exercises the relevant headless tool shape
without claiming compatibility with an unavailable concrete package.
