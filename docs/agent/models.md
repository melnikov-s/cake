# Models

## Presets and references

models.list/info: presets. Omit overrides unless requested; strings are preset names, not model IDs. Explicit model settings use provider/modelId/thinkingLevel/fastMode.
Sessions/drafts/children/workflow agents and project workers use the configured preset; Cake Chat workers use its Subagent default (inherit chat unless changed).
models.reference produces message chips without launching/switching models. Forward explicit settings/preset, excluding display-only presetName. A reference alone is not launch permission.
Preserve edited effort/Fast overrides; a preset name alone may lose them. [Model reference details](model-generation.md#model-references) covers canonical text and snapshots.

## Images and classifiers

models.select-non-chat: image/classifier preference; use result.model in Pi's codemode API. Null means discover available models. Unavailable requested/preferred model: ask before billed substitution.
Read Pi's generation API when needed; do not invent auth/providers. Check stopReason/errorMessage; show native image blocks inline, never base64 prose.
Save only when requested, using original bytes and verified destination; never silently regenerate billed images.
[Generation workflow](model-generation.md): preference precedence, codemode call shape, credentials, classifier calls, original-byte saving and errors.
