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
   Cake starts loading the model in the background when dictation is turned on and
   when the main window opens with dictation enabled. Focusing a field during that
   load waits for it rather than starting another. A background load failure is
   shown, with Retry, the next time a field is focused.
3. Speech appears progressively. Enter drains recognition before submission where
   the field already supports Enter-to-submit; pauses alone do not submit dictation.
   Existing multiline and slash-menu behavior remains available.
4. Use the circular waveform to mute/unmute. Escape stops dictation before the field's
   usual Escape action. Muting preserves visible text; unmuting resumes at the caret.
   Mute is shared across windows, including screen-capture annotations. The capture
   overlay inherits the originating window's mute before annotation focus and then
   follows live shared mute updates; an already-observed update takes precedence
   over its initial routing snapshot.

Each listening round keeps the **first clear voice** it hears, even if that voice is
not yours. There is no setup phrase or saved speaker profile. Cake buffers the opening
while it checks who is speaking, then recognizes the accepted opening as well as later
matching speech. Speech without enough evidence (including very short first words on
their own), detected overlap and uncertain matches can be omitted. The filter is not
speaker authentication or a guarantee against background speech.

A round starts when a dictation field starts listening. Blur, thinking pauses, edits
that start a new text insertion, and the quiet boundary used by spoken-send and discard
rules do **not** pick a new speaker. Sending, Escape, muting, switching fields or chats,
model changes, entering conversation mode, disabling dictation, and capture failure
end the round. Listening again starts with no speaker selected. Conversation mode
continues to use its own unfiltered recognition path.

Recognition re-decodes a bounded recent-audio window with fresh decoder state.
Recent words and punctuation can change as more speech arrives, including across
thinking pauses. Older words settle after two matching hypotheses and at least six
seconds of following audio. A fourteen-second audio budget forces old text to settle
if agreement never arrives, retaining two seconds of left context and a revisable
recent tail. Pauses stop feeding room noise but do not seal the recognition text;
Enter explicitly finalizes it. Audio stays in memory and is released on finalization
or when a new insertion starts.

Focusing a field chooses the destination. Dictation then stays with that field until
an explicit end: Escape, mute, disabling dictation, sending, focusing another dictation
field, leaving the chat (the field unmounts), starting voice mode or changing the speech
model. Losing focus never stops or pauses it, before or after speech: clicking elsewhere
in Cake, another app, the desktop, Browser Mode or the VS Code panel keeps writing into
the same field. Escape only reaches Cake while Cake has keyboard focus. Typing or moving
the caret seals the current spoken span; late recognition must not replace manually
edited text.
The recognition model stays warm while dictation is enabled. The microphone and
audio worklet are reused across field/chat switches with a gap of up to 500 ms;
audio during that gap and queued audio from the old field are discarded. Longer
idle gaps, muting, disabling dictation and stopping release the microphone.
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
Removal affects Cake's managed recognition data, not external folders or the bundled
engine.

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

- [Bundled speaker manifest](../../native/dictation/speaker-manifest.json):
  FluidInference Core ML conversions of [pyannote segmentation 3.0](https://huggingface.co/pyannote/segmentation-3.0)
  (CNRS, MIT) and [WeSpeaker ResNet34-LM](https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM)
  (CC BY 4.0), about 13.8 MB total. Cake ships the unmodified conversions with
  FluidInference's `NOTICE.md` and `LICENSE`. The manifest pins and verifies each file.

Recognition, detection and speaker matching are offline after installation. The
local helper keeps one round's anonymous speaker reference in memory, discarding it
along with pending audio at the end of the round. Cake does not record, upload or log
voiceprints or microphone audio. Submitting a draft and using optional utility cleanup
are separate provider operations; utility cleanup receives accepted text only.

The helper evaluates bounded windows (1.024 seconds of output plus up to 512 ms of
context on either side). It gates audio **before** recognition; only verified samples
reach Parakeet. Work runs on the recognition side of capture, in one speaker-inference
slot, which can process the next window while recognition consumes the previous one.
The existing eight-second capture backlog limit still fails visibly rather than building
an unbounded queue or passing unchecked audio through. A document crash, reload or
loss of its window terminates the round's worker if a normal reset cannot run.

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
them with Cake. Local helpers need only Apple system frameworks at runtime. No
additional punctuation model, tokenizer or ONNX Runtime is installed.
A missing helper is an application repair/build-mode issue, not a reason to install
a toolchain on the user's machine.

## Text processing

**Settings → Voice & Dictation → Text processing** applies to dictation and voice mode:

- **Recognition (default):** use Parakeet's local, revisable recognition directly,
  including its punctuation and capitalization. No provider or second text model.
- **Utility cleanup:** use only the configured utility model. Without one, or on
  processing failure, retain raw recognition rather than substituting the chat model.
  Only the current spoken insertion goes to the provider—not typed prefixes, project
  files, previous messages or microphone audio. Provider retention and billing apply.

The editable **Utility cleanup prompt** and **Reset** control the cleanup guidance.
The default preserves meaning, uncertainty, negations and technical identifiers while
cleaning punctuation, filler, stutters and nearby spoken corrections. A model prompt
cannot guarantee semantic fidelity; review important instructions before submission.

In utility mode, gray text marks the spoken insertion awaiting optional cleanup;
typed text stays ordinary. Utility cleanup runs on a sustained pause or finalization,
not every audio frame. Recognition itself revises recent text in both modes. Manual
edits and mute seal that insertion. Voice auto-send finalizes recognition and
any selected utility cleanup before submitting the composer.

Tune shared speech detection in **Speech input** settings; capture changes take effect
on refocus or voice-mode re-entry. For microphone noise, output and diagnostic guidance,
see [conversation mode](conversation-mode.md#troubleshooting-and-diagnostics).

## Opt-in native verification

Run protocol tests without a physical microphone:

```sh
pnpm test:dictation:native
```

To exercise the real helper and Core ML model, provide an existing compatible Parakeet
model. Stage the helper outside `out/`: integration setup replaces `out/` with a slim build.

```sh
helper_dir="$(mktemp -d)"
pnpm validation:run -- node scripts/build-dictation.mjs "$helper_dir"
CAKE_DICTATION_TEST_HELPER="$helper_dir/cake-dictation" \
  CAKE_DICTATION_TEST_MODEL=/absolute/path/to/model \
  pnpm test:integration tests/integration/dictation-native.test.ts
```

To also test labeled real speech, set `CAKE_DICTATION_TEST_LIBRISPEECH` to the
`LibriSpeech/test-clean` directory from the [OpenSLR LibriSpeech release](https://www.openslr.org/12/)
(CC BY 4.0, read aloud by LibriVox volunteers). The opt-in test reads clips from speakers
6930 and 1320; it also mixes two clips to exercise overlap. The test does not download
fixtures or use a microphone.

Follow [Electron testing](electron-testing.md) for compiled output and hidden-window
rules. Recorded fixtures and controlled tests do not validate physical-microphone
quality, false accepts across arbitrary voices, or recognition accuracy in a noisy room.
