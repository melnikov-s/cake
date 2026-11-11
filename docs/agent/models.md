# Models

## Presets and references

models.list/info: presets. Omit overrides unless requested; strings are preset names, not model IDs. Explicit model settings use provider/modelId/thinkingLevel/fastMode.
Sessions/drafts/children/workflow agents and project workers use the configured preset; Cake Chat workers use its Subagent default (inherit chat unless changed).
models.reference produces message chips without launching/switching models. Forward explicit settings/preset, excluding display-only presetName. A reference alone is not launch permission.
Preserve edited effort/Fast overrides; a preset name alone may lose them. [Model reference details](model-generation.md#model-references) covers canonical text and snapshots.

## Switch an existing session

`sessions.set-model {sessionId, model}` accepts a preset name or explicit settings. Validate the receipt: idle targets change only; active targets stop, await provider/tool termination, set the model, and receive exactly one Continue. Do not send another Continue. History and queued human input survive; no settings are edited.

Self-switch returns `accepted` so its tool result can finish before cancellation. `sessions.model-switch-status {sessionId}` reports the latest handoff stage and outcome; `continued` proves turn admission, not a successful answer. Failed configuration can leave a partial change; inspect the reported stage, do not assume rollback. Receipts are process-local; null after release/restart is not success.

Project/Automation sessions, discussion Side Chats and permanent Global/Project chats are supported. Companion follows the Settings utility model; private subagents have launcher-owned single-turn lifetimes, so cancel/relaunch through their owner rather than switch them in place. Both exclusions fail before stopping anything.

## Images and classifiers

models.select-non-chat: image/classifier preference; use result.model in Pi's codemode API. Null means discover available models. Unavailable requested/preferred model: ask before billed substitution.
Read Pi's generation API when needed; do not invent auth/providers. Check stopReason/errorMessage; show native image blocks inline, never base64 prose.
Save only when requested, using original bytes and verified destination; never silently regenerate billed images.
[Generation workflow](model-generation.md): preference precedence, codemode call shape, credentials, classifier calls, original-byte saving and errors.
