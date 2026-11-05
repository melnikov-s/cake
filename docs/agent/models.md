# Models and generation

Read before model selection, image generation or classification. Also read Pi's codemode documentation before native generation.

## Chat and worker models

Call `cake models.list` for preset names/defaults; `models.info` with an exact name returns provider, model ID, thinking level and Fast mode. Model inputs accept a preset name such as `"Sol"` or `{ provider, modelId, thinkingLevel, fastMode? }`. Strings are preset names, never raw model IDs.

Omit model overrides unless the user explicitly requests one:

- Sessions, drafts, children and workflow agents use the configured default preset's complete settings, not your current model.
- Project Session subagents also use that preset.
- Cake Chat subagents use the user's Subagent default model setting: inherit Cake Chat's current model unless changed.

## Inline model references

Right-click a message input and choose **Insert model** to use the existing model picker. Click a composing chip to edit that reference; sent chips are read-only. References do not change the conversation model or start an agent.

Tools can create the identical representation with `models.reference { model: "Sol" }` or an explicit `{ provider, modelId, thinkingLevel, fastMode }` model. Insert the returned `text` into an ordinary message body using existing send operations; this needs no desktop/caret control. `models.list` and `models.info` discover selections.

The durable text is `<cake-model>{"provider":"openai-codex","modelId":"example","thinkingLevel":"high","fastMode":true}</cake-model>`. Presets additionally include `preset: { id, prompt? }` and a display-only `presetName`; explicit settings are a snapshot, not a mutable preset lookup. When the surrounding user request asks you to use a reference, pass its provider/modelId/thinkingLevel/fastMode and optional preset to the existing `model` argument. Omit display-only `presetName`. Preserve overrides when a preset's effort/Fast settings were edited; a preset name alone would lose those overrides. A reference by itself never authorizes launching an agent.

The same text is stored in drafts, queues, recovery inputs and Pi history—there is no separate chip metadata or transcript. Copying a composing chip copies its canonical text. Invalid tokens remain literal text.

## Select an image or classifier model

Use Pi's native `models` API inside `codemode` when enabled. Resolve Cake's image preference with `tools.cake({ command: "models.select-non-chat", input: { type: "image" } })`.

The structured return is `{ command, result }`: destructure `const { result: selected } = await tools.cake(...)`. Pass `selected.model` to `models.generateImages`. If null (no preference), discover models with `models.getAvailableOfType("image")`.

Pass an explicit user request as `requested: { provider, modelId }`; it overrides the preference. If a request/preference is unavailable, report the error and ask before substituting another billed model. Preferences are advisory, not restrictions.

For classifiers, select with `type: "classifier"`, then `models.classify(model, { state, questions })`. Never infer background classification or Auto routing from a preference. Do not select an image model as the conversation's chat model.

Built-in image models use OpenRouter credentials, not a ChatGPT subscription. Eligible Project Sessions enable codemode by default. If unavailable, explain that explicit tool selections, disabled extensions or restricted chats may exclude it. Pi's `defaultTools: ["+codemode"]` enables it in eligible Project Sessions. Never invent providers or claim chat authentication enables generation.

## Generate and display

Call `models.generateImages(model, { input })` with text blocks and supported base64 reference-image blocks. Read reference bytes through file tools, for example `tools.bash` with Node's `readFileSync(...).toString("base64")`. Check success; reject truncated output. Never copy base64 through prose.

Check `stopReason` and `errorMessage`; report errors/cancellation, not success. Show images with `image(block)` and accompanying text with `text(block.text)`. Never print or store image data in codemode's JSON store.

## Save only when requested

Generation alone must not save workspace files. For a requested save, decode the original generated block in the same script, before returning the preview. Stage base64 in a temporary file with `tools.write`; use `tools.bash` and Node to decode it, write the requested image, and remove the temporary file. Large base64 shell arguments can exceed OS limits; do not embed them in commands.

Quote paths, honor destination/overwrite intent and verify success. Then display the saved image inline with Markdown image syntax using its path (relative or absolute). Pi may resize transcript images; later previews are not original bytes, and an unsaved original may be unrecoverable. Never regenerate a billed image silently merely to save it.
