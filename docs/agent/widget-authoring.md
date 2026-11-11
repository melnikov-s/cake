# Widget authoring

For generated widget source, repairs or capability questions. [Interactions](interactions.md) chooses the surface; [themes](widget-theme.md) covers live styling.

## Language and review

`widgets.present` accepts `widget.language:"html"` for a complete self-contained document with inline CSS/JavaScript: no JSX, imports, packages, external scripts or bundling.
React is the default for installed libraries, component-heavy UI and prototype manifests. Both use the widget sandbox, browser/visual acceptance, immutable revisions, fallback and retained accepted PNG. Replacements preserve language.
Give the specialist verified facts, audience, goal, bounded data, interactions and fallback; not a diary or invented facts. Only already-installed libraries are available; dependency authorization happens outside the private generation branch.

Permanent Project Chat and Global Chat publish directly with `widgets.present`; use `widgets` or `widgets.present.help` for discovery. Their specialist receives the supplied brief/data, not inherited chat history. The accepted widget appears on the successful tool result. `widgets.attach` places the same widget instance in chat slots; there is no separate Session Plugin renderer or SDK. `artifacts.commands` discovers the Cake bridge, not direct widget publishing.

## Saved JSON state

HTML uses `globalThis.cakeArtifact.read()`, `getSnapshot()`, `subscribe(listener)`, `replace(value,expectedVersion)`. Await hydration/read before mounting an editor or saving. Version zero uses seed; saved null is real data. Save against the observed version, reread conflicts, never blindly retry.
React uses `useArtifactState(initialValue)` from `@cake/artifact-sdk`: value, hydrated, version, save and error. The hydrated value is authoritative; choose the JSON format and save timing.
Display/request widgets have no durable artifact state. Source revisions and live lineage state are separate; a pinned source view may still show current saved state.

## Chat attachments

Create with `widgets.present` or `widgets.instantiate`, then attach the returned lineage:

```json
{
  "command": "widgets.attach",
  "input": {
    "id": "summary-panel",
    "lineageId": "conversation-summary",
    "target": { "kind": "global" },
    "slot": "right"
  }
}
```

Targets: `global`, `project-chats` (all durable Project Chats), `project-sessions` (all regular work sessions), or `{kind:"session",sessionId}`. These are categories across Cake, not all sessions in one project. Slots: `top`, `bottom` (above composer), `left`, `right`, and `tab`. The `tab` slot requires `target: {kind:"global"}`; session and category targets are rejected. It occupies a full Workspace pane, selected from a title dropdown beside To-dos/Sessions. Only visible global tab attachments appear there. One tab attachment per widget lineage; reuse its attachment ID rather than creating another. Reuse the attachment ID to move/reorder it; `order` is a zero-based position. Hide/Show unmounts/remounts chat-slot views without deleting state. Tab views remain mounted and active when unselected, when the pane closes, and across conversation/project/tool-mode switches; selection never resets local or saved state. Detaching/deleting a selected tab falls back to the last built-in Workspace view. Explicit hiding or detaching stops its view subscriptions; artifact background jobs keep their existing independent lifetime. `widgets.detach {id}` removes placement only. `widgets.attachments {}` lists current placements.

Broad attachments reuse one lineage/state/backend runtime through multiple disposable views. Independent data requires explicit `widgets.instantiate` with a new lineage ID. Closing a view destroys its iframe, timers and subscriptions—not its saved state or explicit background runtime/jobs. A surface must be open; scrolling offscreen does not destroy it. Widget code cannot attach itself or manage permissions. Agents can attach directly on user request.

## Structured Cake results

Programmatic Cake tool calls return `{command,result}` JSON for every data operation, not only operations declaring an exact output schema. Native agent-facing text remains compact; both come from the same execution. Widget `cake.tools.call` unwraps the result. Image results carry JSON metadata and an explicit warning that pixels require a native image-capable call. Oversized results return a JSON truncation receipt; narrow or paginate instead of parsing a partial preview.

Session lists—including workflow rosters—are structured backend data; their text tables are agent-only projections. Existing task-input redaction still applies before agent presentation; a protected workflow row may contain only its safe session identity/title.

## Cake SDK and updates

HTML uses `globalThis.cake`; React imports `useCake`, `useCurrentSession`, `useCakeEvent`, `usePolling` from `@cake/artifact-sdk`. Both use the same sandbox/bridge as every widget.

- `await cake.tools.call(command,input)` returns canonical JSON data, never agent-formatted text or a `{command,result}` presentation envelope. Ordinary Cake-command authority and explicit-session requirements still apply. Credential/permission-management controls and widget attachments are unavailable to widget code.
- `await cake.session.getCurrent()` returns this view's current `{sessionId,kind}` or `null`, after its initial context arrives. `await cake.session.subscribeCurrent(listener)` calls initially and on changes, returning an unsubscribe function. A global widget has no inferred owning session; use current-session context or explicit tool targets. Each view has its own context, even when saved state is shared.
- `await cake.events.subscribe(topic,filter,listener)` returns an unsubscribe function. Topics: `session.changed`, `session.transcript.changed`, `session.removed` (optional `sessionId` filter), and `artifact.execution.changed` (optional `lineageId` filter). Subscribe before reading data. `{kind:"ready",topic}` means read current data after initial subscription/reconnection. Change events contain `{kind:"change",topic,sessionId,reason}` or `{kind:"change",topic,lineageId}`. Transcript events invalidate data; they do not contain or mutate the transcript/model context. Subscription failures are delivered as `{ok:false,error}`.
- `await cake.poll.subscribe({key,command,input,intervalMs},listener)` returns an unsubscribe function. Intervals: 1000–3600000ms, measured after each completed call; requests never overlap. Updates: `{ok:true,result}` or `{ok:false,error}`. Identical instance/query/scope polls share one backend loop; window-owned calls retain their window identity. The last view's release stops the loop. Use explicit runtimes/schedules for background work, never hidden views or author-owned timers.
- `cake.state.read/replace/subscribe` access the same versioned instance state as `cakeArtifact`. `read`/`replace` are async; `subscribe` returns its unsubscribe function synchronously.

React `useCakeEvent(topic,filter,listener)` and `usePolling(options,listener)` release old subscriptions when their inputs change or the component unmounts; `null` disables them. The host independently releases every resource when a frame closes or fails, even if author cleanup is missing.

Runtime errors and unhandled rejections stop only that view. Retry reloads with saved state. Repair sends its exact widget reference/revision and bounded diagnostic to Global Cake Chat, preserving the instance and attachments. Legacy saved Session Plugin records remain untouched for a separate data migration; they are not mounted by the new system.

## Links and downloads

Ordinary `<a href="https://…" target="_blank">` links, including React links, open through the viewing device's host. `window.open(url)` also opens through that host but returns null.
Do not rely on popup handles, document.write, named-window reuse or window features. Downloads and local hashes remain ordinary anchors; do not replace them with window.open. No opener, parent DOM, Node or Electron access is implied.

## Read aloud

Inline and attached widgets use the configured voice: HTML `globalThis.cakeSpeech`; React `useSpeech()` from `@cake/artifact-sdk`. Request speech in the brief.
Provide speak(text,{from}?), pause, resume and stop. speak returns a Promise; snapshot includes status, error, chunk/chunks and start/end offsets for sentence highlighting. Keep text readable when speech fails.
Only one speaker runs; unmount/close stops it. Missing output configuration gives a readable error. No microphone, voice choice or audio-file capability is granted; display/request widgets have no speech.

## Prepared skill templates

A loaded skill may supply widget.json with language and skill-relative source. Cake prepares its renderer at fresh-session startup from already-added widget libraries; ordinary creation reuses retained output.
Use the skill's complete `widgets.instantiate({template,id,title,initialState,fallback})` call and data instructions directly. Each instance is an independent document.
No artifact/editor search, extra renderer reads, codemode generation, package/settings discovery or silent install/substitute. Setup failures remain explicit. This is generic skill/library support, not a built-in drawing-library integration.
