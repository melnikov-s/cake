# Global artifact authoring

Global artifacts are retained artifact lineages, not installed apps. Use the
existing widget/template authoring path for a view, then attach independent
backend logic if needed. Markdown, images and files can be global without logic.
There is no install flow, capability grant, permission screen or hosting Pi session.

## Discover and identify

- `artifacts.globals({query?,offset?,limit?})`: globally retained metadata.
- `artifacts.list`: artifacts linked to the calling conversation.
- `artifacts.viewing({})`: visible references and active artifact per connected
  window, including fullscreen; `callingWindow` identifies the caller's bound
  window when available. Do not guess which artifact "this" means.
- `artifacts.inspect({lineageId})`: metadata, runtime state and schedule receipts.
- `artifacts.tools({lineageId})`: semantic names, descriptions and JSON input/output
  schemas, without starting code.
- `artifacts.call({lineageId,name,input})`: validated tool invocation, including
  while the view is closed. The result is validated against the declared schema.

These are Cake subcommands, not new normal Pi tools. Both ordinary Project
Sessions and permanent Project/global Cake Chat expose discovery and invocation.

`artifacts.set-global({lineageId,global:true})` makes retention independent of
creator-session deletion. Setting false removes that retention root, not links or
revision history. `artifacts.delete({lineageId})` permanently removes the lineage,
schedules and Cake-owned data after best-effort runtime cleanup. It never deletes
files the artifact wrote elsewhere.

Titles and optional descriptions are metadata; `artifacts.create/update/replace`,
`html.present`, `widgets.present` and `widgets.instantiate` accept descriptions.
Changing immutable artifact metadata publishes a revision, not a private app record.

## Backend logic

Publish logic onto an existing widget:

```js
{
  command: "artifacts.runtime.publish",
  input: {
    lineageId: "pr-dashboard",
    expectedRevision: 1,
    runtime: {
      source: "let refreshes = 0; return { tools: { refresh: async () => { refreshes++; await data.write({refreshes}); return {refreshes}; } } };",
      tools: [{
        name: "refresh",
        description: "Refresh the dashboard and return its refresh count.",
        inputSchema: {type: "object", additionalProperties: false},
        outputSchema: {
          type: "object", required: ["refreshes"], additionalProperties: false,
          properties: {refreshes: {type: "integer"}}
        }
      }]
    }
  }
}
```

`source` is an async factory **body**, not an ES module. Return
`{tools:{name:handler}, lifecycle?:{start,focus,blur,unmount,stop,delete}}`.
A tool receives `(input,event)`; hooks receive an event containing its lifecycle
name and optional view identity. The lexical APIs are:

- `cake(command,input = {})`: canonical validated Cake command bridge.
- `data.read()`: current artifact-scoped JSON value, initially null.
- `data.write(json)`: persist the artifact's JSON value now.

One long-lived QuickJS execution retains factory closures. There is no DOM,
Node global, direct `fetch`, or hidden full browser. Use `network.request` through
Cake, and durable schedules rather than view-local polling timers. Save meaningful
changes as they happen; stop/delete hooks are not crash-proof save points.
The persistence format and any format changes belong to the artifact.

Arguments/results must be JSON. Tool names must match returned handlers. Tool
schemas are JSON Schema documents (draft-07); invalid definitions, arguments and
results fail explicitly. `artifacts.resolve-reference` projects inert
`runtime.js.txt` and `runtime-tools.json` for selective exact-revision authoring.

Current source publication refreshes already-running logic and live views while
preserving saved data. Unopened runtimes stay lazy. An in-flight call uses its
resolved revision; the next call sees the new revision. Historical previews do
not start another live runtime or schedules. A failed reload is reported in
runtime status without undoing a committed revision.

## UI uses the same backend

React views import `useArtifact` from `@cake/artifact-sdk`:

```js
const artifact = useArtifact();
const result = await artifact.callTool("readiness", {});
```

HTML views call `globalThis.cakeArtifact.callTool("readiness", {})`. Both use the
same handlers as `artifacts.call`. `globalThis.cake.call(command,input)` is the UI
Cake bridge; React uses `useArtifact().cake.call(command,input)`. Views are disposable:
closing/collapsing unmounts DOM but does not stop backend logic or tools. Use
private persistence or tools to reconstruct the next view, not whole-app
serialization on close. Existing scoped saved-state APIs remain available for
view data but are not the required agent-facing interaction API.

## Trusted host commands

Artifact code is fully trusted for host functionality. Technical worker/frame
isolation, schema validation and canonical command authority remain in effect;
there is no capability allowlist or artifact permission UI.

Discover `commands.list` or `commands.help({command})` through `cake`, or inspect
`artifacts.commands` from the agent gateway. `artifacts.command` supplies parity
with the UI bridge. The bridge includes canonical backend project, session,
settings and automation commands, plus:

- `filesystem.read({path,encoding?:"utf8"|"base64"})`.
- `filesystem.write({path,content,encoding?})` (parent directory must exist).
- `filesystem.list({path})`.
- `network.request({url,method?,headers?,body?,responseEncoding?})` returns status,
  headers and text/base64 body, including non-2xx responses; no automatic retry.
- `chat.prompt({sessionId,text,delivery?})` submits artifact-attributed input to an
  **explicit existing destination**, returning admission rather than an answer.

Paths are absolute on the backend host, not relative to a deleted creator or the
viewing machine. Network requests execute on that backend too. This is not a
promise that every Pi tool is a Cake command. Agent-originated calls carry their
real calling session; background calls do not invent a current/creating session.
Session-relative operations need a real caller. Native/window/device functionality
needs an actual connected host/calling session and may fail when unavailable on a
standalone backend. Such failures do not create a Pi session or shadow backend.

## Durable background work

Configure a named schedule invoking one declared handler:

```js
{
  command: "artifacts.schedules.configure",
  input: {
    lineageId: "pr-dashboard", name: "refresh", handler: "refresh", input: {},
    schedule: {_tag: "Interval", startsAt: "2030-01-01T00:00:00.000Z", everySeconds: 300}
  }
}
```

Schedule shapes reuse automation's interval/once/cron schemas; read operation help
for the exact contract. The existing backend automation worker invokes handlers
deterministically, without an LLM or conversation message. Reconfiguration replaces
one stable artifact/name identity; opening multiple views creates no schedules.
After backend restart, overdue work catches up once instead of replaying missed
ticks. No execution occurs while the backend is off.

`artifacts.runtime.pause` stops logic and durably pauses background work, including
future schedule configuration until explicit `resume`. Tools remain discoverable
and can lazy-start logic when called. Opening, `start`, or `restart` does not resume
paused schedules. `artifacts.schedules.list` and runtime status expose bounded
latest success/failure receipts. Remove one schedule with
`artifacts.schedules.remove({lineageId,name})`.

The deterministic PR-dashboard tests exercise refresh/readiness/send-to-chat with
fake network/chat boundaries, closed views, persistence, revision reload and
schedules. They do not prove a live GitHub integration or access credentials.
