# Local dictation

Dictation applies to opted-in Cake writing fields, not VS Code, terminals, browser
pages, widgets or OS-wide typing. It requires Apple Silicon and macOS 14+.

## Setup and use

1. Open **Settings → Voice & Dictation** and download Parakeet, or select an existing
   compatible **Parakeet TDT v2 Core ML** folder. It must contain
   `Preprocessor.mlmodelc`, `Encoder.mlmodelc`, `Decoder.mlmodelc`,
   `JointDecision.mlmodelc` and `parakeet_vocab.json`. MLX, ONNX, Whisper and NeMo
   weights are not interchangeable with these bundles.
2. Enable **Dictation mode**, focus a Cake prose field and wait for the speech
   control to finish preparing. The first Core ML load can take longer while macOS
   prepares the model. Installed users need no Python, Swift, Xcode or developer tools.
3. Speech appears progressively. Enter drains recognition before submission where
   the field already supports Enter-to-submit; pauses alone do not submit dictation.
   Existing multiline and slash-menu behavior remains available.
4. Use the circular waveform to mute/unmute. Escape mutes before the field's usual
   Escape action. Muting preserves visible text; unmuting resumes at the caret.

Focus determines the destination. Blurring, typing or moving the caret seals the
current spoken span; late recognition must not replace manually edited text.
[Conversation mode](conversation-mode.md) uses the same recognizer but submits the
normal composer and can speak replies. It temporarily suppresses dictation in its
composer without changing the Dictation preference.

On macOS, microphone denial can be repaired in **System Settings → Privacy & Security
→ Microphone**, then by toggling dictation off/on. Restoring the enabled preference
does not restore a recording: capture prepares only in an eligible focused field.

## Model installation and attribution

Model selection is stored in `<Electron userData>/dictation/settings.json`; managed
Parakeet data lives in its `model/` subdirectory. Downloads require explicit action,
support cancellation and verify every pinned file before publishing an installation.
Removal affects Cake's managed recognition data, not external folders, the separately
installed punctuation model or the bundled engine.

Use the checked-in manifests for exact versions, sizes and checksums:

- [Parakeet manifest](../../src/services/dictation/parakeet-coreml-manifest.json):
  [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
  [Core ML conversion by FluidInference](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml),
  CC BY 4.0. Cake does not modify the published weights.
- [Bundled detector manifest](../../native/dictation/vad-manifest.json): Silero VAD,
  Core ML conversion by FluidInference, MIT licensed. Detector data and license ship
  with the helper; users do not install it separately.
- [Native package](../../native/dictation/Package.swift) and its checked-in resolution
  pin FluidAudio. Its Apache-2.0 license and third-party notices accompany the helper.

Recognition and detection are offline after installation. Audio/recognition buffers
remain in memory; Cake does not record audio files or log transcripts. Submitting a
draft and using optional utility cleanup are separate provider operations.

## Native build and distribution

**Use `pnpm build:slim` for ordinary non-native agent work, UI tests and screenshots.**
It neither invokes Swift nor probes its toolchain/downloads native assets, and removes
native output from a preceding full build. Local Swift engines are unavailable in
slim output; startup never compiles them. `pnpm build:start:slim` launches that build.

Full native source builds on Apple Silicon require Swift 6.2+; Command Line Tools
is sufficient. This is a build-machine requirement, not an installed-app requirement.

```sh
pnpm build:dictation  # recognition helper only
pnpm build:speech    # speech-output helper only
pnpm build           # full application including native engines
```

The [native build scripts](../../scripts/build-dictation.mjs) resolve pinned packages,
build release helpers and stage executables, resource bundles, detector data and
license notices under `out/main/native`. Native build dependencies/assets may be
fetched during building, not installed-app startup or recognition.

Both helpers use [the shared native cache](../../scripts/native-build-cache.mjs)
under `$CAKE_HOME/cache/native-builds/v1` (default `~/.cake/cache/native-builds/v1`).
`CAKE_NATIVE_CACHE` overrides the location. Content keys include native source,
dependency resolution, packaging scripts, manifests/licenses and toolchain/platform
inputs, not the checkout path. Identical inputs across worktrees reuse a complete
bundle. Changes to TypeScript or source timestamps alone do not rebuild Swift.

Per-key locks serialize builds and restaging. Failed builds do not replace successful
bundles. An abandoned lock reports its path: stop remaining native builds before
removing it. Never symlink mutable Swift `.build` trees across source revisions.
Deleting `out/` only restages a valid cached bundle.

Use `CAKE_NATIVE_REBUILD=1 pnpm build` only for deliberate native verification that
must bypass the bundle cache. SwiftPM still uses keyed incremental scratch. A bypass
is also needed after manually changing dependency checkouts, normally immutable inputs.

Distribution must preserve native helpers/resources outside ASAR and sign/notarize
them with Cake. Local helpers need only Apple system frameworks at runtime. Optional
punctuation also requires ONNX Runtime's native bindings/libraries outside ASAR.
Python is used only for developer evaluation and
[tokenizer export](../../scripts/export-punctuation-tokenizer.py), never installed Cake.
A missing helper is an application repair/build-mode issue, not a reason to install
a toolchain on the user's machine.

## Text processing: three exclusive modes

**Settings → Voice & Dictation → Text processing** applies to dictation and voice mode:

- **Raw:** retain recognition as supplied by Parakeet.
- **Local punctuation:** explicitly download the offline English model first. It
  adjusts punctuation/case without removing filler or summarizing. Model/runtime
  working memory is substantially larger than the download size; measure on the
  target device rather than treating weight size as a RAM budget.
- **Utility cleanup:** use only the configured utility model. Without one, or on
  processing failure, retain raw recognition rather than substituting the chat model.
  Only the current spoken insertion goes to the provider—not typed prefixes, project
  files, previous messages or microphone audio. Provider retention and billing apply.

The editable **Utility cleanup prompt** and **Reset** control the cleanup guidance.
The default preserves meaning, uncertainty, negations and technical identifiers while
cleaning punctuation, filler, stutters and nearby spoken corrections. A model prompt
cannot guarantee semantic fidelity; review important instructions before submission.

Local punctuation uses
[punctuation_fullstop_truecase_english](https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english),
licensed Apache-2.0. Weights, attribution and license install under
`<Electron userData>/dictation/punctuation/model/`. The bundled exported tokenizer
includes its source hash, transformation notice and license. This news-trained English
model is not a perfect conversational or technical grammar model.

Gray text marks a provisional spoken span; typed text stays ordinary. Manual edits,
blur and mute seal that span. Local punctuation can revise recent words across thinking
pauses; utility cleanup runs on a sustained pause or finalization, not every audio frame.
Voice auto-send finalizes processing before submitting the composer.

Tune shared speech detection in **Speech input** settings; capture changes take effect
on refocus or voice-mode re-entry. For microphone noise, output and diagnostic guidance,
see [conversation mode](conversation-mode.md#troubleshooting-and-diagnostics).

## Opt-in native verification

Run protocol tests without a physical microphone:

```sh
pnpm test:dictation:native
```

To exercise the real helper and Core ML model, provide existing compatible assets:

```sh
pnpm build
CAKE_DICTATION_TEST_MODEL=/absolute/path/to/model pnpm test:integration tests/integration/dictation-native.test.ts
```

For real local punctuation inference without downloading a model:

```sh
CAKE_PUNCTUATION_TEST_ROOT=/absolute/punctuation/root pnpm test:integration tests/integration/local-punctuation.test.ts
```

The same punctuation environment variable enables real-inference cases in the isolated
Electron dictation smoke. Follow [Electron testing](electron-testing.md) for compiled
output and hidden-window rules. Synthetic speech and controlled fixtures verify mechanics,
not physical-microphone quality or broad recognition accuracy. Keep measured results and
model comparisons in artifacts rather than appending a verification history here.
