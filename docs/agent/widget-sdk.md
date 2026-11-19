# Widget Cake SDK

For widget code calling Cake, following sessions/events, polling or adding composer items. [Widget authoring](widget-authoring.md) covers source, saved state and repair.

## Structured Cake results

Programmatic Cake tool calls return `{command,result}` JSON for every data operation, not only operations declaring an exact output schema. Native agent-facing text remains compact; both come from the same execution. Widget `cake.tools.call` unwraps the result. Image results carry JSON metadata and an explicit warning that pixels require a native image-capable call. Oversized results return a JSON truncation receipt; narrow or paginate instead of parsing a partial preview.

Session lists—including workflow rosters—are structured backend data; their text tables are agent-only projections. Existing task-input redaction still applies before agent presentation; a protected workflow row may contain only its safe session identity/title.

## Cake SDK and updates

HTML uses `globalThis.cake`; React imports `useCake`, `useCurrentSession`, `useCakeEvent`, `usePolling` from `@cake/artifact-sdk`. Both use the same sandbox/bridge as every widget.

- `await cake.tools.call(command,input)` returns canonical JSON data, never agent-formatted text or a `{command,result}` presentation envelope. Ordinary Cake-command authority and explicit-session requirements still apply. Credential/permission-management controls and widget attachments are unavailable to widget code.
- `await cake.session.getCurrent()` returns this view's current `{sessionId,kind}` or `null`, after its initial context arrives. `await cake.session.subscribeCurrent(listener)` calls initially and on changes, returning an unsubscribe function. A global widget has no inferred owning session; use current-session context or explicit tool targets. Each view has its own context, even when saved state is shared.
- `await cake.events.subscribe(topic,filter,listener)` returns an unsubscribe function. Topics: `session.changed`, `session.transcript.changed`, `session.removed` (optional `sessionId` filter), and `artifact.execution.changed` (optional `lineageId` filter). Subscribe before reading data. `{kind:"ready",topic}` means read current data after initial subscription/reconnection. Change events contain `{kind:"change",topic,sessionId,reason}` or `{kind:"change",topic,lineageId}`. Transcript events invalidate data; they do not contain or mutate the transcript/model context. Subscription failures are delivered as `{ok:false,error}`.
- `await cake.poll.subscribe({key,command,input,intervalMs},listener)` returns an unsubscribe function. Intervals: 1000–3600000ms, measured after each completed call; requests never overlap. Updates: `{ok:true,result}` or `{ok:false,error}`. Identical instance/query/scope polls share one backend loop; window-owned calls retain their window identity. The last view's release stops the loop. Use explicit runtimes/schedules for background work, never hidden views or author-owned timers.
- `await cake.composer.attach({label,itemId,data?,sessionId?})` adds one of this widget's items as a removable chip in a chat composer draft. It never sends. Without `sessionId` it targets this view's current chat (`cake.session.getCurrent()`); with one it targets that chat's draft, which persists until the user opens it. `await cake.composer.targets()` lists editable chats as `{sessionId,kind,title,projectPath?,projectName?,current?}`. Limits: label ≤200 characters, `itemId` ≤256, `data` JSON ≤8 KiB, 20 attachments per composer. The host records the widget origin; repeating a widget+`itemId` pair is a no-op. Results: `{ok:true,target,duplicate,sent:false,warning?}` or `{ok:false,error,target?}`. When sent, the model receives label, `itemId`, `data` and the widget origin as data.
- `cake.state.read/replace/subscribe` access the same versioned instance state as `cakeArtifact`. `read`/`replace` are async; `subscribe` returns its unsubscribe function synchronously.

React `useCakeEvent(topic,filter,listener)` and `usePolling(options,listener)` release old subscriptions when their inputs change or the component unmounts; `null` disables them. The host independently releases every resource when a frame closes or fails, even if author cleanup is missing.
