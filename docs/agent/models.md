# Models and generation

Read before model selection, image generation or classification. Also read Pi's codemode documentation before native generation.

## Chat and worker models

Call `cake models.list` for preset names/defaults; `models.info` with an exact name returns provider, model ID, thinking level and Fast mode. Model inputs accept a preset name such as `"Sol"` or `{ provider, modelId, thinkingLevel, fastMode? }`. Strings are preset names, never raw model IDs.

Omit model overrides unless the user explicitly requests one:

- Sessions, drafts, children and workflow agents use the configured default preset's complete settings, not your current model.
- Project Session subagents also use that preset.
- Cake Chat subagents use the user's Subagent default model setting: inherit Cake Chat's current model unless changed.

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

Quote paths, honor destination/overwrite intent and verify success. Then display the saved image inline with Markdown image syntax using its workspace-relative path. Pi may resize transcript images; later previews are not original bytes, and an unsaved original may be unrecoverable. Never regenerate a billed image silently merely to save it.
