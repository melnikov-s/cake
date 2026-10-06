# Local dictation

Cake's dictation mode is opt-in and applies only to explicitly registered Cake prose fields.
It does not inject keystrokes into VS Code, terminals, browser pages, widgets, or the OS.

## Using it

1. Open **Settings → Dictation** on Apple Silicon running **macOS 14 or later**.
2. Choose **Download Parakeet model**, or supply an absolute path to an existing compatible
   **Parakeet TDT v2 Core ML** folder. It must contain `Preprocessor.mlmodelc`, `Encoder.mlmodelc`,
   `Decoder.mlmodelc`, `JointDecision.mlmodelc`, and `parakeet_vocab.json`.
   MLX, ONNX, Whisper, and NeMo weights are not interchangeable with these compiled bundles.
3. Enable **Dictation mode**. Cake loads and warms the model, reusing it while available and re-preparing after a voice-mode handoff.
4. Focus a Cake chat composer, annotation comment, or another opted-in writing field.
   Wait for **Listening** before speaking. **Preparing dictation…** means capture is not ready.
   Core ML's first load can take longer while macOS prepares the model for the device.
5. Speech appears progressively. Where Enter already submits, it drains the final audio before
   submitting once. Shift+Enter and existing multiline/slash-menu behavior remain unchanged.
6. Click the circular waveform at the start of the input to mute; click it again to unmute.
   Muting stops microphone capture and discards pending recognition without changing visible
   text or Dictation mode. The crossed waveform remains available while muted. Typing still
   works, and unmuting resumes at the current caret. Escape mutes before a field's usual Escape action.
   Mute survives field and session changes, but resets on restart or when Dictation mode is toggled.

Installed Cake users need **no Python, uv, Swift, Xcode, or other developer tools**. Cake includes
its compiled speech helper and FluidAudio; Core ML is part of macOS.

There are no ready sounds. Dictation mode defaults off until the user enables it. Enabled mode
and microphone choice are window-owned preferences persisted through window-state snapshots and
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
never replace the active model. Removal clears Cake's private model data and selection, not
external model folders or the bundled engine. A missing helper is an application repair error,
not a reason to install a runtime on the user's computer.

Model: [NVIDIA Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
[Core ML conversion by FluidInference](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v2-coreml),
licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Cake does not modify the published model files.
Engine: [FluidAudio 0.17.4](https://github.com/FluidInference/FluidAudio/tree/v0.17.4), Apache-2.0;
its license and third-party notices accompany the helper.

Only model installation needs network access. The helper uses `AsrModels.loadLocal`, never the
library's download APIs. PCM and recognition buffers live only in memory; Cake does not record
audio files or log transcripts. FluidAudio's debug/info logging and console mirroring are disabled.
Submitting the resulting draft to an agent is separate and follows that agent's provider settings.

## Native build and distribution

`native/dictation/` is a Swift package pinned by `Package.swift` and `Package.resolved`.
**Building Cake from source** on Apple Silicon requires the Swift 6.2+ toolchain (Command Line
Tools is sufficient). This is a build-machine requirement, not an installed-app requirement.

The Electron Vite main build calls `scripts/build-dictation.mjs`. It compiles the release helper
and copies the executable, SwiftPM resource bundle, and license notices into `out/main/native/`.
FluidAudio is linked into the helper; the only dynamic runtime dependencies are Apple system
frameworks/libraries. The optional NeMo text-processing trait is disabled. SwiftPM may fetch
its declared binary artifact while resolving the package, but it is not linked or shipped.

Main locates the helper relative to its compiled module, so `pnpm start` snapshots carry the
helper and resources with the rest of `out/`. Other platforms can build Cake without a Swift
installation; Dictation displays its platform requirement. Distribution packaging must preserve
these native files outside an ASAR archive and sign/notarize the helper along with the app.
No user-side compilation, package manager, or executable download is involved.

## Ownership and concurrency

| State/resource                             | Authority and owner                                  | Lifetime / persistence                         | Concurrency                                       |
| ------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Model installation and selected path       | Main `Dictation` Service                             | Path persisted in private settings             | Mutations serialized with inference               |
| Warm native worker and Core ML models      | Main `Dictation` Service scope                       | Process-local; killed on disable/main teardown | One inference request at a time                   |
| Installation/engine projection             | `DictationStore`, observed through validated RPC     | Window-local projection of main                | Ordered `SubscriptionRef` snapshots               |
| Enabled mode and microphone choice         | Window `DictationStore`                              | Persisted window-state preferences             | Explicit user edits; last local edit wins         |
| Mute, capture phase, focus and audio queue | Window `DictationStore`                              | Ephemeral; no audio persistence                | Focus takes latest; mute/maintenance stop capture |
| Draft text                                 | Existing composer/annotation owner                   | Existing draft persistence                     | Dictation updates only its current insertion span |
| Selection and status geometry              | Shared Textarea DOM adapter and `DictationIndicator` | Mounted field                                  | Native input events, no synthetic OS typing       |

The renderer captures mono 16 kHz float32 PCM through an AudioWorklet and batches about 800 ms.
Main exchanges validated NDJSON with the helper over private stdio. The helper uses FluidAudio's
sliding-window recognizer with 1.6-second chunks, 0.4-second right lookahead, and four seconds of
left context. Each request waits for its model windows to finish, so the internal stream cannot
silently accumulate an unbounded audio backlog. Final requests flush all remaining windows.
A new utterance ID discards the previous decoder and text while retaining loaded model weights.

The helper runs a warm inference pass before advertising readiness. Latency depends on hardware
and context: this is progressive transcription, not an instant-word guarantee. An audio backlog
above eight seconds stops capture with a visible error rather than silently dropping audio.
Request validation rejects malformed, excessive, nonfinite, or out-of-range PCM. Main enforces
startup and inference timeouts and owns worker cancellation and teardown.

`Textarea` has an explicit `dictation` prop. `ComposerInput` opts in, so all authoritative `Chat`
consumers share the same behavior. Additional prose fields can opt in without another composer
or Store. Code/configuration editors, path/search fields, and embedded surfaces stay excluded.

## Verification

- `pnpm test:dictation:native`: standalone Swift protocol/audio-validation/window-scheduling tests;
  works with Command Line Tools without XCTest or Swift Testing frameworks.
- `tests/app/services/dictation.test.ts`: real Service lifecycle, warmup serialization,
  cancellation, model selection/removal, platform/engine availability, and RPC-encodable state.
- `tests/app/services/dictation-model-download.test.ts`: real installer with deterministic fake
  downloads; pinning/checksums, atomic publication, cancellation/retry, local model validation.
- `tests/app/renderer/dictation-workflow.test.tsx`: startup gates, persisted preference restoration,
  maintenance pauses, progressive results, focus boundaries, manual edits, final-audio submission,
  and failures.
- `tests/electron/dictation.smoke.spec.ts`: real Service/RPC/Store, fake external native process,
  Chromium's fake microphone, real AudioWorklet, controlled-input typing, settings, chat, and
  annotation Enter submission, and preference retention across app restarts. No model download or
  physical microphone required.
- `tests/integration/dictation-native.test.ts`: opt-in **real compiled helper and Core ML model**,
  using macOS-synthesized speech, progressive recognition, Enter-style final flushing, and new-focus
  isolation. Requires the built app and an existing compatible model folder:

```sh
pnpm build
CAKE_DICTATION_TEST_MODEL=/absolute/path/to/model pnpm test:integration tests/integration/dictation-native.test.ts
```

Synthetic speech verifies the real engine/protocol, not live-microphone quality or broad accuracy.
