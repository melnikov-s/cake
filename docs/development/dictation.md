# Local dictation

Cake's dictation mode is opt-in and applies only to explicitly registered Cake prose fields.
It does not inject keystrokes into VS Code, terminals, browser pages, widgets, or the OS.

## Using it

1. Open **Settings → Voice & Dictation** on Apple Silicon running **macOS 14 or later**.
2. Choose **Download Parakeet model**, or supply an absolute path to an existing compatible
   **Parakeet TDT v2 Core ML** folder. It must contain `Preprocessor.mlmodelc`, `Encoder.mlmodelc`,
   `Decoder.mlmodelc`, `JointDecision.mlmodelc`, and `parakeet_vocab.json`.
   MLX, ONNX, Whisper, and NeMo weights are not interchangeable with these compiled bundles.
3. Enable **Dictation mode**. Cake loads and warms the model, reusing it while available and re-preparing after a voice-mode handoff.
4. Focus a Cake chat composer, annotation comment, interview prose answer (including a select's
   **Other** response), or another opted-in writing field.
   Wait for the loading spinner inside the speech control to become waveform bars before
   speaking. The spinner means capture is not ready; no preparation header is shown.
   Core ML's first load can take longer while macOS prepares the model for the device.
5. Speech appears progressively. Where Enter already submits, it drains the final audio before
   submitting once. Shift+Enter and existing multiline/slash-menu behavior remain unchanged.
6. Click the circular waveform at the start of the input to mute; click it again to unmute.
   Muting stops microphone capture and discards pending recognition without changing visible
   text or Dictation mode. The crossed waveform remains available while muted. Typing still
   works, and unmuting resumes at the current caret. Escape mutes before a field's usual Escape action.
   Mute survives field and session changes, but resets on restart or when Dictation mode is toggled.

Installed Cake users need **no Python, uv, Swift, Xcode, or other developer tools**. Cake includes
its compiled speech helper, FluidAudio, and a small local Silero speech detector; Core ML is part of macOS.

There are no ready sounds. Dictation mode defaults off until the user enables it. Enabled mode
and microphone choice, along with the shared text-processing mode (utility cleanup by default), are window-owned
preferences persisted through window-state snapshots and
restored on launch. Only an explicit preference toggle changes enabled mode; voice-mode handoffs,
model maintenance, focus changes, and errors pause capture without rewriting it. Restoring enabled
mode does not restore a recording: capture prepares when an eligible writing field receives focus.
Model selection and installation persist separately in main.
[Conversation mode](conversation-mode.md) suppresses dictation only in its active composer, without changing the window's Dictation mode preference. Exiting voice mode or switching sessions allows focused-field dictation to resume automatically. Focusing a different opted-in writing field hands the shared recognizer back to dictation and exits voice mode. Toggling the dictation preference alone does not exit voice mode.
Conversation mode updates and submits the normal composer draft and can speak assistant prose.
Microphone access is requested on first capture. macOS permission denial can be repaired in
System Settings → Privacy & Security → Microphone, then by toggling dictation off and on.

Focus is the destination: blurring a field immediately seals its visible text and discards
pending recognition. No old result can modify the previous field or spill into a new field.
Moving the cursor or typing seals the current speech span and starts a new decoding generation
without reopening the microphone. Leaving Cake or the last eligible field stops capture but
keeps the model warm. Recognition failure blocks the pending dictation submission; ordinary
keyboard editing remains available.

## Model installation and attribution

The main process stores the selected path in `<Electron userData>/dictation/settings.json`.
Managed model data lives in that directory's `model/` subdirectory. Downloads are pinned to
`FluidInference/parakeet-tdt-0.6b-v2-coreml` revision
`ee09c569f73759e6d44c9bd16766f477b2b36d39`:

- 21 files totaling **464,413,247 bytes** (464 MB / 443 MiB);
- compiled Core ML preprocessor, 6-bit-palettized encoder, decoder, joint decision model, vocabulary;
- every file checked against a pinned byte count and SHA-256 digest in
  `src/services/dictation/parakeet-coreml-manifest.json`;
- a model attribution notice placed alongside downloaded files.

Nothing downloads on app startup. Installation requires explicit user action, reports progress,
and supports cancellation/retry. Files are staged separately; incomplete or corrupt downloads
never replace the active model. Recognition removal clears only Cake's private Parakeet data and selection, not
external model folders, the separately installed punctuation model, or the bundled engine. A missing helper is an application repair error,
not a reason to install a runtime on the user's computer.

Model: [NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
[Core ML conversion by FluidInference](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Cake does not modify the published model files.
Engine: [FluidAudio 0.17.4](https://github.com/FluidInference/FluidAudio/tree/v0.17.4), Apache-2.0;
its license and third-party notices accompany the helper.

The bundled speech detector is **Silero VAD v6.2.1**, Core ML conversion by FluidInference,
MIT licensed. Its five compiled files total **1,063,425 bytes** (about 1 MiB). The build pins
`FluidInference/silero-vad-coreml` revision `b419383c55c110e2c9271fa6ee0ea83d03c70d96` and checks
byte counts and SHA-256 hashes in `native/dictation/vad-manifest.json`. The model and Silero
license ship beside the helper; existing user-selected Parakeet folders need no changes.

Speech detection, recognition, and optional local punctuation need no network access after installation. Optional utility-model
post-processing can use the network as described below. The helper uses `AsrModels.loadLocal`, never the
library's download APIs. PCM and recognition buffers live only in memory; Cake does not record
audio files or log transcripts. FluidAudio's debug/info logging and console mirroring are disabled.
Submitting the resulting draft to an agent is separate and follows that agent's provider settings.

## Native build and distribution

`native/dictation/` is a Swift package pinned by `Package.swift` and `Package.resolved`.
**Building Cake from source** on Apple Silicon requires the Swift 6.2+ toolchain (Command Line
Tools is sufficient). This is a build-machine requirement, not an installed-app requirement.

The Electron Vite main build calls `scripts/build-dictation.mjs`. It builds the release helper
with pinned dependency resolution (`--force-resolved-versions`) and consistent diagnostic flags,
and copies the executable, SwiftPM resource bundle, bundled detector, and license notices into
`out/main/native/`. The build fetches and verifies detector data when it is not in the worktree's
ignored `.build/cake-vad/` cache; installed-app startup and recognition never download it.
FluidAudio is linked into the helper; the only dynamic runtime dependencies are Apple system
frameworks/libraries. The optional NeMo text-processing trait is disabled. SwiftPM may fetch
its declared binary artifact while resolving the package, but it is not linked or shipped.

Both native build scripts use `scripts/native-build-cache.mjs` to retain complete bundles under
`native/<package>/.build/cake-bundle-<product>/`, separately from Vite's disposable `out/`.
Content hashes cover native sources, `Package.swift`, `Package.resolved`, packaging scripts,
asset manifests/licenses, and the selected compiler, SDK, architecture, OS and build environment.
Unchanged inputs log **Reusing cached** and do not invoke `swift build`, strip executables or
fetch detector data; deleting `out/` only restages the cached bundle. Cache validation checks
artifact contents and permissions. Failed builds do not replace the last successful cache.
Changes to TypeScript/UI code or source timestamps alone do not rebuild Swift.

Use `CAKE_NATIVE_REBUILD=1 pnpm build` to bypass Cake's bundle cache and rerun native build steps
(SwiftPM still uses its own incremental compilation). This is also necessary after manually
editing downloaded dependency checkouts, which are normally treated as immutable pinned inputs.
Deleting a product's `cake-bundle-*` directory also invalidates that entry; there is no need to
delete the entire Swift `.build/` tree or its downloaded detector cache. Native compilation is a
source-build operation, not part of restarting an already-built Cake.

Main locates the helper relative to its compiled module, so `pnpm start` snapshots carry the
helper and resources with the rest of `out/`. Other platforms can build Cake without a Swift
installation; Dictation displays its platform requirement. Distribution packaging must preserve
these native files outside an ASAR archive and sign/notarize the helper along with the app.
No user-side compilation, package manager, or executable download is involved.

Optional local punctuation uses the bundled `onnxruntime-node` CPU runtime and JavaScript
Unigram tokenizer. Snapshot launches retain `node_modules`; distribution packaging must likewise
carry ONNX Runtime's native bindings/libraries outside ASAR. The native runtime is imported lazily
only when local punctuation is first requested. Python is used solely for developer model evaluation
and the reproducible `scripts/export-punctuation-tokenizer.py` export, never in installed Cake.

## Ownership and concurrency

| State/resource                                 | Authority and owner                                   | Lifetime / persistence                          | Concurrency                                        |
| ---------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| Model installation and selected path           | Main `Dictation` Service                              | Path persisted in private settings              | Mutations serialized with inference                |
| Warm native worker and Core ML models          | Main `Dictation` Service scope                        | Process-local; killed on disable/main teardown  | One inference request at a time                    |
| Speech classifications and phrase gate         | Native helper; independent capture/recognition states | Ephemeral per capture/insertion; no persistence | Detection and transcription share the Service lock |
| Installation/engine projection                 | `DictationStore`, observed through validated RPC      | Window-local projection of main                 | Ordered `SubscriptionRef` snapshots                |
| Enabled mode, microphone, text-processing mode | Window `DictationStore`                               | Persisted window-state preferences              | Explicit user edits; last local edit wins          |
| Mute, capture phase, focus and audio queue     | Window `DictationStore`                               | Ephemeral; no audio persistence                 | Focus takes latest; mute/maintenance stop capture  |
| Draft text                                     | Existing composer/annotation owner                    | Existing draft persistence                      | Dictation updates only its current insertion span  |
| Selection and status geometry                  | Shared Textarea DOM adapter and `DictationIndicator`  | Mounted field                                   | Native input events, no synthetic OS typing        |

The main Service also owns optional punctuation installation, its warm CPU inference session,
and one ephemeral insertion context keyed by utterance ID. It retains settled labels and reruns
approximately the latest 96 words with 16 earlier words as context; an older ASR word correction
reopens the affected suffix. This is not a persisted transcript or a multi-session cache. A separate
semaphore serializes punctuation download/removal/inference without blocking recognition.
The editable cleanup prompt is application-owned, persisted through `cakePrompts`, and projected
by `CakePromptSettingsStore`; neither dictated passages nor local labels are persisted there.

The renderer captures mono 16 kHz float32 PCM through an AudioWorklet and batches about 800 ms.
Main exchanges validated NDJSON with the helper over private stdio. The helper uses FluidAudio's
sliding-window recognizer with 1.6-second chunks, 0.4-second right lookahead, and four seconds of
left context. Each request waits for its model windows to finish, so the internal stream cannot
silently accumulate an unbounded audio backlog. Final requests flush all remaining windows.
A new utterance ID discards the previous decoder and text while retaining loaded model weights.

The helper classifies 256 ms frames with the bundled detector, using speech-probability hysteresis
(0.6 to enter, 0.4 to continue by default), not a microphone-volume cutoff.
**Settings → Voice & Dictation → Speech input** shares sensitivity, continuation threshold,
minimum speech duration, audio lookback and maximum utterance length between dictation and voice
mode. The settings UI labels every shared control **Dictation + voice mode**; send/countdown and
interruption controls are labeled **Voice mode only** and never submit or interrupt dictation.
See [control scope and defaults](conversation-mode.md#speech-input-settings).

Each microphone capture freezes the current shared settings. Dictation detector requests receive
its thresholds, and every PCM request carries the same validated native recognition settings.
A new native utterance ID captures the settings; changing them mid-ID is rejected rather than
silently changing segmentation. The native gate waits for sustained speech (200 ms by default),
retains its full onset plus lookback (600 ms by default, replacing the old fixed 256 ms preroll),
and keeps a fixed 256 ms tail to protect word boundaries. Refocus a writing field to apply edits
on the next dictation capture. Recognition text still belongs only to the current insertion. Longer quiet frames are held back; if speech resumes before the 1.5-second phrase
boundary, their timing is retained as zeros rather than room noise. Otherwise the phrase is finalized
and its text retained unchanged. Continuous speech is finalized in configurable segments (30 seconds by default).
Resumed phrases append exactly once to the same insertion; every response is a full replacement,
never a text delta. Explicit finalization supplies 400 ms of silent decoder lookahead to protect
short commands and final syllables. Pauses in dictation do **not** submit the draft.

Both dictation and voice mode use the same detector/model for capture decisions through `dictation.detectSpeech`.
Its capture-scoped recurrent state is separate from recognition state, so detecting ahead cannot
advance the recognizer's detector. `speech-capture.ts` serializes detection, buffers at most eight
seconds, flushes partial frames on finish, and drops stale results on cancellation. The voice Store
still owns its configurable auto-send policy (three seconds by default) and transcript-confirmed interruption policy; neither applies to dictation.

## Text processing: three exclusive modes

**Text processing**, in Settings → Voice & Dictation, is a persisted window preference shared
by dictation and voice mode. The choices are mutually exclusive:

- **Raw** leaves Parakeet's words, capitalization and punctuation unchanged.
- **Local punctuation** revises punctuation and initial-letter case with an offline English CPU
  classifier. It neither removes filler words nor summarizes. Choose **Download punctuation model**
  explicitly before selecting this mode. The pinned published FP32 model is **209,532,928 bytes**
  (about 210 MB), larger than the original ~100 MB target because the ~53 MB quantized candidate
  changed question boundaries in evaluation. Downloads show progress, support cancellation/removal,
  verify byte count and SHA-256, and leave installed weights intact on incomplete transfers.
  Weights live in `<userData>/dictation/punctuation/model/` with attribution and Apache-2.0 license.
- **Utility cleanup** (default) uses only the explicitly configured utility model. Without one,
  recognition remains raw; Cake never substitutes the conversation model. This sends only the
  current dictated insertion to that provider and can incur costs and its retention policy.
  Typed text, project files, previous messages, and microphone audio are not sent for cleanup.

The editable **Utility cleanup prompt** and **Reset** live on the same page and apply to both
input workflows. Its default requests punctuation/capitalization/spacing fixes, filler and accidental
stutter removal, and nearby spoken self-corrections while preserving meaning, uncertainty, negations,
technical identifiers, paths and code. Custom guidance may instead condense rambling. The fixed
JSON output contract and transcript-as-data guard remain outside that editable guidance. This is
not the broader **Reword** action and does not consult workspace files.

The English model is
[`1-800-BAD-CODE/punctuation_fullstop_truecase_english`](https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english),
revision `b26fd1c40e88678859048898218ea4edcc24c84a`, Apache-2.0. Cake does not alter its weights.
Its SentencePiece vocabulary is exported into a bundled Unigram tokenizer, with source hash,
transformation notice and license. Predictions are applied to original source words, not decoded
vocabulary pieces. Code spans, identifiers, URLs, paths, decimals and other symbol-bearing text
are protected from normalization. Bounded overlapping windows of at most 254 subtokens plus
special tokens limit each inference pass. A tentative terminal mark is withheld during live speech;
recent words stay revisable across audio phrase boundaries, and finalization supplies the last mark.
This is a news-trained English model, not a perfect conversational grammar or technical-term model.

Raw recognition appears immediately at the existing progressive cadence, without waiting for
text processing. Utility mode marks the current insertion awaiting cleanup gray; local mode keeps
its last four words provisional after inference. Typed prefixes/suffixes stay normal. Cleanup completion (including raw-text fallback) restores normal text styling.
Opting out, manual edits, blur and mute seal the span and clear the temporary display treatment.
Both processed modes use the shared native `Textarea` with an aria-hidden, pointer-transparent text mirror;
editing, selection, accessibility and focus still belong to the real input. The mirror matches
its measured padding, first-line indent, wrapping and scroll position. Highlight metadata is
capture/insertion-local and not persisted.

Local mode processes each progressive recognition result and keeps its terminal mark provisional
through thinking pauses; dictation finalizes on Enter. Utility mode cleans the full insertion
after three seconds of detected non-speech or on Enter. Voice mode's deliberate auto-send finalizes
either processed mode before submission. Ongoing speech and shorter pauses never trigger utility work, and a sustained
pause triggers only once. There is at most one cleanup in flight per insertion. Enter waits for
pending cleanup and reuses the result when the finalized raw text matches its input; only changed
text causes another call. It does not reprocess its own cleaned output. Voice mode cleans the final utterance before auto-send; raw recognition still
controls interruption acceptance. Empty cleanup may retract an entire insertion without sending.
Corrections only affect the current insertion/utterance, never earlier submitted messages or
manually edited text. New audio boundaries do not force punctuation boundaries in cleanup.

Each utility backend call is bounded to 32,000 input/output characters and ten seconds, with no retry,
tools, or persisted utility transcript. Output is a validated JSON text field; provider failures,
invalid output, and disconnected transport keep raw speech. Focus changes, typing/cursor movement,
mute and disposal invalidate dictation cleanup. Voice cleanup verifies capture generation and
manual draft edits before applying. Cleanup never gates microphone readiness or changes the
native recognizer's output. Local inference failure likewise retains raw speech and exposes an
error without invoking utility cleanup or preventing submission. Model instructions are not a guarantee of semantic fidelity;
real hesitant-speech quality still needs user evaluation.

The helper runs a warm inference pass before advertising readiness. Latency depends on hardware
and context: this is progressive transcription, not an instant-word guarantee. An audio backlog
above eight seconds stops capture with an error-marked speech icon and tooltip details rather
than silently dropping audio. Capture status and errors never reserve a header or change
writing-field height; all status text remains available to screen readers.
Request validation rejects malformed, excessive, nonfinite, or out-of-range PCM. Main enforces
startup and inference timeouts and owns worker cancellation and teardown.

`Textarea` has an explicit `dictation` prop. `ComposerInput` opts in, so all authoritative `Chat`
consumers share the same behavior. `ArtifactForm` uses it for text, multiline, and select **Other**
answers in interviews and form artifacts. Enter in a single-line answer drains final recognition
before advancing or submitting; multiline answers retain newline behavior. Numeric fields, radio
choices, and checkboxes do not capture speech. Additional prose fields can opt in without another
composer or Store. Code/configuration editors, path/search fields, and embedded surfaces stay excluded.

## Verification

- `pnpm test:dictation:native`: standalone Swift protocol/audio-validation/window-scheduling and speech-gate tests;
  works with Command Line Tools without XCTest or Swift Testing frameworks.
- `tests/app/services/dictation.test.ts`: real Service lifecycle, warmup serialization,
  cancellation, model selection/removal, platform/engine availability, and RPC-encodable state.
- `tests/app/services/dictation-model-download.test.ts`: real installer with deterministic fake
  downloads; pinning/checksums, atomic publication, cancellation/retry, local model validation.
- `tests/app/domain/dictation-post-process.test.ts`: real bounded PiModels policy with a fake provider;
  configured-model selection, prompt scope, invalid/empty output, timeout and cancellation.
- `tests/app/services/punctuation-model-download.test.ts`: pinned data download, progress,
  checksum/size rejection, staging cleanup, cancellation, retry, attribution and license.
- `tests/app/services/local-punctuation.test.ts`: original-word/symbol preservation, paused-question
  revision, provisional/final labels, bounded rolling/overlapping windows, context capitalization,
  correction reopening, insertion isolation and cancellation.
- `tests/app/renderer/cake-prompt-settings-workflow.test.tsx`: real application persistence,
  shared processing selector, editable cleanup prompt and reset.
- `tests/app/renderer/dictation-workflow.test.tsx`: startup gates, persisted preference restoration,
  maintenance pauses, progressive results, focus boundaries, manual edits, final-audio submission,
  pause-triggered cleanup, completed/in-flight result reuse on Enter, changed-text reprocessing,
  explicit retractions, stale cleanup rejection, transport fallback, and failures.
- `tests/electron/dictation.smoke.spec.ts`: real Service/RPC/Store, fake external native process,
  Chromium's fake microphone, real AudioWorklet, controlled-input typing, settings, chat, and
  annotation Enter submission, and preference retention across app restarts. No model download or
  physical microphone required. Set `CAKE_PUNCTUATION_TEST_ROOT` to an existing punctuation
  installation root to also verify real local CPU inference, typed-prefix preservation, gray tail,
  question continuation and final Enter in the native annotation dialog.
- `tests/integration/local-punctuation.test.ts`: opt-in production tokenizer/runtime/weights,
  paused-question revision and technical-text preservation; no downloads:
  `CAKE_PUNCTUATION_TEST_ROOT=/absolute/punctuation/root pnpm test:integration tests/integration/local-punctuation.test.ts`.
- `tests/electron/interview-open.smoke.spec.ts`: real `interview.open` tool request and response,
  shared form fields, fake external recognizer, typed and dictated custom/text/multiline answers,
  Enter final-audio draining, focus handoffs, and keyboard-only numeric fields.
- `tests/integration/dictation-native.test.ts`: opt-in **real compiled helper and Core ML model**,
  using macOS-synthesized speech, quiet speech, short commands, progressive recognition, Enter-style
  final flushing, new-focus isolation, noise-only input, and speech/noisy-pause/resumed-speech stability. Requires the built app and an existing compatible model folder:

```sh
pnpm build
CAKE_DICTATION_TEST_MODEL=/absolute/path/to/model pnpm test:integration tests/integration/dictation-native.test.ts
```

Synthetic speech verifies the real engine/protocol, not live-microphone quality or broad accuracy.
