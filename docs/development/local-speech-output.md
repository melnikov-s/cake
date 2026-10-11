# Local speech output

Pocket TTS is an optional offline output provider for desktop
[conversation mode](conversation-mode.md). It requires Apple Silicon and macOS 14+.
Installed users need no Python, Swift, Xcode or API key.

## Installation and privacy

In **Settings → Voice & Dictation → Speech output**, select **Pocket TTS (local)**
and explicitly download its English Core ML model and Alba voice. The model download
is approximately 370 MB; use the [pinned manifest](../../src/services/speech/pocket-tts-manifest.json)
for exact files, revision, sizes and SHA-256 digests. There is no automatic download
or cloud fallback.

Managed data is under `<Electron userData>/speech-output/pocket-tts/model/`.
Downloads are staged and verified before replacing an installation; cancellation
preserves existing data. Removal affects only managed model data. Local settings
are separate from cloud credentials and survive switching providers.

Synthesis is offline after installation. Chat and optional utility cleanup still
follow their selected providers' network/billing policies. Faster speech can sound
less natural even when pitch is preserved; evaluate it by listening.

Attribution ships in `ATTRIBUTION.txt`: Pocket TTS by Kyutai, Core ML conversion by
FluidInference, and Alba voice by Alba MacKenna, under CC BY 4.0. See
[Alba's source/license](https://huggingface.co/kyutai/tts-voices#alba-mackenna).

## Build and distribution

`pnpm build:speech` builds [`native/speech/`](../../native/speech/) with its checked-in
dependency resolution and stages the helper, resources, manifest and licenses in
`out/main/native`. Full builds include native speech; ordinary agent/UI work uses
`pnpm build:slim`, which omits it without compiling Swift or downloading native assets.
See [native build caching](dictation.md#native-build-and-distribution) for source-build
requirements, cache invalidation and explicit bypass.

Package native assets outside ASAR and sign/notarize the helper along with Cake.
No Python or developer toolchain is required on the installed user's machine.

## Native verification

```sh
swift run --package-path native/speech SpeechTempoTests
pnpm build:speech
CAKE_SPEECH_TEST_MODEL=/path/to/managed/cache/root pnpm test:integration tests/integration/pocket-tts-native.test.ts
```

Native inference is opt-in with explicitly supplied pinned assets. It downloads
nothing and uses no microphone or billed provider. Numerical checks and ASR do not
prove naturalness: pronunciation, punctuation prosody and faster-speed quality need
listening. Signing/notarization and minimum-supported macOS validation are separate
release checks. Record test results and listening evaluations in artifacts, not here.
