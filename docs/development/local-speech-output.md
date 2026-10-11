# Local speech output

Pocket TTS is an optional speech-output provider for desktop conversation mode, alongside ElevenLabs. Cake bundles a Swift/Core ML helper using **FluidAudio 0.17.4**, the same framework as dictation. Recognition and synthesis retain independent workers so listening/interruption is not blocked by generation. Requires Apple Silicon/macOS 14+; installed users need no Python, Swift, Xcode or API key.

## Installation and privacy

Select **Pocket TTS (local)** in **Settings → Voice & Dictation**, then explicitly choose **Download Pocket TTS · 370 MB**. One English fp16 model and the Alba voice are offered; there is no automatic download or cloud fallback.

- The minimal v2.1 English Core ML installation is **369,779,063 bytes**, across 22 pinned files. This excludes unused precision/placement variants, source `.mlpackage` bundles, cloning assets and other voices. fp16 removes the previous MLX 8-bit conversion from the quality path.
- Repository, revision, exact sizes and SHA-256 digests are in `src/services/speech/pocket-tts-manifest.json`. Data comes from `FluidInference/pocket-tts-coreml`; Cake does not modify model weights.
- Data installs under `<Electron userData>/speech-output/pocket-tts/model/Models/pocket-tts-coreml/v2.1/english`. The enclosing `model` directory is the helper's private FluidAudio cache root.
- Selection and local speed persist in `pocket-tts/settings.json`, independently from cloud credentials/voice/speed. Each provider retains its rate across switching/restarts.
- Downloads stage separately and publish an installation identity only after all hashes pass. Failure/cancellation preserves any existing installation. Removal touches only managed model data.
- The former MLX installation is incompatible: its marker does not match the new manifest, so it is shown as uninstalled. Users must explicitly download the Core ML model; a successful install replaces the old managed data atomically. Provider choice, speed and cloud preferences are retained.

Before loading, the helper verifies every manifest asset's size and SHA-256. This includes all graphs, constants, Alba and `bos_before_voice.bin`, ensuring FluidAudio's cache loader never enters its download/backfill paths. No voice cloning or alternate voices are exposed. Inference is offline; microphone capture and recognition are unchanged. Chat and optional utility cleanup still follow their selected providers' network policies.

Attribution ships in `ATTRIBUTION.txt`: Pocket TTS by Kyutai, Core ML conversion by FluidInference, and Alba voice by Alba MacKenna, under CC BY 4.0. See [Alba's source/license](https://huggingface.co/kyutai/tts-voices#alba-mackenna).

## Ownership and streaming

`PocketTtsLive` owns the scoped warm process, serial installation/selection/inference, cancellation, preferences and secret-free installation state. `speech-output.ts` routes selected-provider operations. RPC and renderer do not duplicate provider policy. `SpeechSettingsStore` owns UI operation/cancellation policy. `ConversationModeStore` owns ephemeral phrase queues, cursors, output arrival wakeups and playback cancellation; these never persist.

The private helper uses NDJSON stdin/stdout:

- Arguments: managed cache root and bundled manifest path. Emit `{"ready":true}` only after verified local loading.
- Requests: `{"text":"...","voice":"alba","speed":1.5}`; text is bounded to 2,000 UTF-16 characters and speed to 1–2×.
- FluidAudio sessions emit **80 ms / 1,920-sample frames at 24 kHz** as generated, not after an entire phrase. Shipped voice conditioning is cached; FluidAudio handles sentence chunking, short-input padding and smart-quote/apostrophe normalization.
- At 1×, samples pass through unchanged. Faster output uses one offline `AVAudioUnitTimePitch` engine per phrase, preserving pitch across frame boundaries with 8,192 input samples (~341 ms) of lookahead. It never opens an audio device or waits for the whole phrase. Completion flushes the exact tempo-adjusted duration.
- Emit sample-aligned signed 16-bit little-endian mono PCM as base64 `pcm` frames, bounded to 65,536 decoded bytes, followed by `{"done":true}`. Non-finite, empty or wholly silent generation fails rather than reporting success.
- Cancellation kills inference; a subsequent explicit request reloads the engine. Unexpected protocol replies/invalid PCM/process exits fail the active stream. Source text, PCM and raw upstream diagnostics are not logged or persisted.

Cake sends sentence-level prose, not a separate request for every comma/semicolon/colon. Generation of the next sentence overlaps playback of earlier audio, including sentences arriving while playback is draining. Playback retains its five-second scheduling bound and immediate cancellation.

Live completed messages without durable entry IDs are eligible even if coalescing suppressed their streaming projection. Durable reconnection/history snapshots, entry-time messages and interrupted replies remain sealed; stable render keys/cursors prevent replay.

## Build and macOS placement

`pnpm build:speech` builds `native/speech/Package.swift` with its checked-in resolution, strips local linker symbols, and copies the executable, resource bundles, pinned manifest and FluidAudio licenses into `out/main/native`. Full Electron builds run both native builders, but unchanged inputs reuse a shared, content-addressed bundle under Cake's `cache/native-builds/v1` without invoking Swift or stripping again—even across worktrees. Ordinary agent/UI work uses `pnpm build:slim`, which omits both local Swift engines without compilation or native downloads. See [native build caching](dictation.md#native-build-and-distribution) for invalidation and explicit cache bypass. No MLX engine/Metal shader artifact or Python runtime is needed for speech output.

The helper uses FluidAudio's `.avoidNeuralEngine` routing: transformer/flow stages can use CPU/GPU, while Mimi remains CPU-only to avoid upstream-documented feedback artifacts and ANE graph failures on some Macs. This is an explicit placement choice, not an automatic retry. The stripped helper is approximately 6 MB on this build; the 370 MB button describes model data only. Package/sign/notarize native assets outside ASAR alongside dictation.

## Verification and release gates

```sh
swift run --package-path native/speech SpeechTempoTests
pnpm build:speech
CAKE_SPEECH_TEST_MODEL=/path/to/managed/cache/root pnpm test:integration tests/integration/pocket-tts-native.test.ts
```

Native tempo tests are device-free and cover incremental output, unchanged 1× samples, duration, pitch/amplitude, short input, ending preservation and invalid input/lifecycle. Fast tests cover installation integrity/cancellation, warm lifecycle, provider routing, real Root/Stores/settings/Chat workflows, completed-only live replies versus reconnection history, sentence boundaries and overlapping playback. Hidden Electron smoke tests retain real RPC/capture/playback with controlled external inference and model assets.

Actual native inference is opt-in with explicitly supplied pinned assets; it checks non-silent PCM, streaming frame sizes, cancellation/reload and incomplete-installation rejection. It downloads nothing and uses no microphone or billed provider. Neither numerical checks nor ASR prove naturalness: contraction pronunciation, punctuation prosody and faster-speed quality require listening before release. Signing/notarization and minimum-supported macOS validation remain separate release checks. There is no claim of quality parity with Kyutai's Python runtime.
