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
  window when available. Each report's `navigation` contains the same window-scoped
  project/session snapshot exposed to its artifact views. Do not guess which artifact
  "this" means or treat the calling agent's session as the user's selection.
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
`{tools:{name:handler}, lifecycle?:{start,focus,blur,unmount,context,stop,delete}}`.
A tool receives `(input,event)`; hooks receive an event containing its lifecycle
name and optional view identity. The lexical APIs are:

- `cake(command,input = {})`: canonical validated Cake command bridge.
- `data.read()`: current artifact-scoped JSON value, initially null.
- `data.write(json)`: persist the artifact's JSON value now.

One long-lived QuickJS execution retains factory closures. There is no DOM,
Node global, direct `fetch`, or hidden full browser. Use `network.request` through
Cake, and durable schedules rather than view-local polling timers. Save meaningful
changes as they happen; stop/delete hooks are not crash-proof save points.
The persistence format and any format changes belong to the artifact. `data` uses
the existing lineage JSON state slot also used by the saved-state view bridge; it
is not a separate backend-versus-view store. Coordinate both sides around one
artifact-owned format.

Arguments/results must be JSON. Tool names must match returned handlers. Tool
schemas are JSON Schema documents (draft-07); invalid definitions, arguments and
results fail explicitly. A handler cannot synchronously call, pause, restart, delete
or publish its own running runtime through Cake: it would wait for itself. These
operations reject before mutations with a typed execution error, not a permissions
decision. Return from the handler and use an external caller for lifecycle control.
Read-only self-discovery and calls to other artifacts remain supported. `artifacts.resolve-reference` projects inert
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

### React to the user's navigation

`useArtifact().context` is reactive. HTML uses `cakeArtifact.getContext()` and
`cakeArtifact.subscribeContext(listener)`, which returns an unsubscribe function.
Read the current snapshot before subscribing/rendering; the subscription supplies
subsequent snapshots. The initial value is null until the host handshake, then:

```js
{
  windowId: "window-lifetime-id",
  viewId: "mounted-view-id",
  project: { path: "/work/my-project", name: "My project" }, // or null
  session: { sessionId: "...", kind: "project-session" } // or null
}
```

Session kinds are `project-session`, `project-chat`, `cake-chat`, and
`automation-session`. Project Chat uses its canonical `project-chat:...` identity;
global Cake Chat has no project. Independently selecting another project clears a
retained session that belongs to the old project. Settings/library/fullscreen
covers retain the underlying navigation selection. Each window has its own
identity and selection. Reopening gets a fresh snapshot, not creator context.

For example, filter a PR dashboard with a private project-to-repository mapping:

```jsx
const { context, value, hydrated } = useArtifact();
const repo = context?.project && value?.repositoriesByProject?.[context.project.path];
const prs = repo ? (value?.prs ?? []).filter((pr) => pr.repository === repo) : [];
return <PRList loading={!hydrated || !context} prs={prs} />;
```

The mapping and PR cache remain artifact-owned saved data. The navigation snapshot
is disposable; do not persist a shared "current project" that makes two windows
fight over the filter. No view reload, polling, or hidden DOM is needed.

Backend code can opt into `lifecycle.context(event)`. It receives an initial
snapshot on current-view mount and later navigation changes while mounted:
`event.navigation` contains `{windowId,project,session}`, alongside the actual
`event.windowConnectionId` and scoped `event.viewId`. Only reported current-revision
views receive this hook; it does not start every global artifact or subscribe an
unmounted view. Use window-keyed transient handling if needed, not an inferred
global session. These facts never become `callingSessionId`: later scheduled or
background tool calls inherit neither a previous caller nor a window.

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
- `shell.run({command,cwd,timeoutSeconds?,env?})` executes shell syntax in a real
  backend subprocess, with separate stdout/stderr and the actual nonzero exit code.
- `network.request({url,method?,headers?,body?,responseEncoding?})` returns status,
  headers and text/base64 body, including non-2xx responses; no automatic retry.
- `chat.prompt({sessionId,text,delivery?})` submits artifact-attributed input to an
  **explicit existing destination**, returning admission rather than an answer.

Paths are absolute on the backend host, not relative to a deleted creator or the
viewing machine. Network requests execute on that backend too. Parse the response's
`body` (for example `JSON.parse(response.body)` for JSON) and check `status`; the
bridge does not replace the response envelope with the server's JSON payload. This is not a
promise that every Pi tool is a Cake command. Agent-originated calls carry their
real calling session; background calls do not invent a current/creating session.
Session-relative operations need a real caller. For user-authorized unattended
maintenance, `cake("sessions.tool-prune", {sessionId})` (or UI
`cake.call("sessions.tool-prune", {sessionId})`) accepts an explicit Project
Session ID or unambiguous discovered suffix without an agent caller. It uses
trusted host authority across registered, accessible projects; actual session
callers retain their project scope. Check `ok` and each `results[].status`: busy,
pending or recovery-blocked work is skipped, never aborted/queued, and drafts,
permanent chats or retired/missing checkouts cannot be compacted. No creator or
parent is inferred, no turn is sent and nothing is restored or resolved. Normal
compaction still requires a real caller.
UI-originated calls carry their
actual renderer connection independently of a conversation link, including calls
from an unlinked global view and its semantic handler. Native/window/device
functionality uses that real connected host; later background invocations do not
inherit an earlier UI window and fail when no required host context exists. Such failures do not create a Pi session or shadow backend.

### Shell-backed CLI integrations

Backend logic, UI `cake.call`, and agent `artifacts.command` share `shell.run`:

```js
const result = await cake("shell.run", {
  command: "my-cli changes --json",
  cwd: "/absolute/backend/repository",
  timeoutSeconds: 30,
  env: { PATH: "/absolute/cli/bin:/usr/local/bin:/usr/bin:/bin" },
});
if (result.timedOut) throw new Error("CLI timed out and was stopped");
if (result.exitCode !== 0) throw new Error(result.stderr || `CLI exited ${result.exitCode}`);
if (result.stdoutTruncated) throw new Error("CLI JSON exceeded the output limit");
const changes = JSON.parse(result.stdout);
```

`command` uses the backend platform's command shell (`/bin/sh` on Unix,
`ComSpec` on Windows), non-interactive and non-login, with stdin closed. Pipes,
quoting and redirection are shell syntax; interpolate external values carefully.
`cwd` is required and must be an absolute backend-host path. There is no creator,
Pi session, renderer, or open-view dependency. No packages, credentials, or shell
profiles are installed/loaded by Cake. CLI authentication/configuration is the
backend host user's own environment.

Environment variables inherit from the backend process, overlaid by `env` without
clearing unrelated variables. In particular a GUI-launched backend may not inherit
terminal PATH customizations: pass an explicit `env.PATH` or use an absolute CLI
path. A remote backend runs commands on the remote host, not the viewing desktop.

The JSON result is `{stdout,stderr,exitCode,timedOut,stdoutTruncated,stderrTruncated}`.
Each stream retains its first 50 KiB of bytes as UTF-8 text (a cut multibyte character
may decode as a replacement character); the remaining bytes are drained and discarded.
There is no full-output file. Check truncation before parsing structured output.
Nonzero exits are normal results, not fabricated successes or typed launch failures.
Timeout returns partial output, `timedOut:true` and `exitCode:null` rather than inventing
an exit status. Invalid input/cwd and process launch/read failures are typed
`ArtifactCommandError` failures. A signal-terminated process also fails with the
platform error message rather than inventing an exit code.

Omitting `timeoutSeconds` means no deadline. Timeout and cancellation close the
invocation's process scope, terminating the process group with up to five seconds
for the shell to exit, then force-killing any remaining group members (including
children of an already-exited shell); timeout returns only after cleanup. Direct Cake
command cancellation propagates interruption, not a successful result. Existing
semantic `artifacts.call` handlers serialize admitted work and are uninterruptible
once admitted, so cancelling that outer call waits for the handler; set
`timeoutSeconds` for bounded shell work inside a handler. Closing a view does not
cancel independent backend logic. Commands that deliberately daemonize out of the
process group are outside the scoped runner's cleanup guarantee.

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
Each due occurrence is consumed only when its individual handler is admitted. If
an earlier handler pauses a later due one-time schedule, that unadmitted occurrence
remains due for explicit resume.
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
