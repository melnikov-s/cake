# Local speech output

Pocket TTS is an optional speech-output provider for desktop conversation mode, alongside ElevenLabs. It uses a bundled Swift/MLX executable on Apple Silicon/macOS 14+; installed users need no Python, Swift, Xcode or developer-tools permission. Unsupported hosts keep cloud output and ordinary text chat available.

## Installation and privacy

Select **Pocket TTS (local)** in **Settings → Speech output**, then explicitly choose **Download Pocket TTS · 141 MB**. There is one model, no format picker or automatic download:

- English Pocket TTS 8-bit weights: 140,230,187 bytes.
- Config, tokenizer and Alba voice bring the pinned total to **140,989,471 bytes**.
- Download URLs, revisions, sizes and SHA-256 digests live in `src/services/speech/pocket-tts-manifest.json`.
- Data installs under `<Electron userData>/speech-output/pocket-tts/model`. The selected provider persists separately in `pocket-tts/settings.json`; cloud secrets, voice, speed and voice list remain in their existing secure storage.
- Downloads stage separately, enforce exact size and digest, then publish an installation marker. Failure/cancellation removes staging and preserves any previous working installation. Removal deletes only managed model data, not keys, provider choice or the bundled engine.
- Switching to local neither refreshes ElevenLabs voices nor synthesizes remotely. A missing local model or engine blocks voice mode with an actionable error, never silently falls back.

After installation, synthesis loads only local files. Microphone inference remains Parakeet. Chat requests still follow the active chat provider; local speech does not make cloud chat offline.

Model and voice attribution ship in `ATTRIBUTION.txt`: Pocket TTS by Kyutai, MLX conversion by mlx-community, and Alba voice by Alba MacKenna, under CC BY 4.0. The [voice source](https://huggingface.co/kyutai/tts-voices#alba-mackenna) explicitly documents Alba's license. Other upstream voices can have different licenses and are not included.

## Ownership and protocol

`PocketTtsLive` owns native-process lifecycle, a warm engine, serial installation/selection/inference, cancellation and authoritative secret-free installation state. `speech-output.ts` combines that state with ElevenLabs settings and routes operations by the selected provider. Thin RPC exposes provider selection, explicit install/remove and shared synthesis/settings observations; neither RPC nor renderer duplicates provider policy.

`SpeechSettingsStore` owns UI operation/cancellation policy and disposes active downloads. `ConversationModeStore` consumes actual provider readiness: local requires a supported host, bundled engine and installed model, not an ElevenLabs key. Existing conversation capture, phrase extraction, playback and transcript ownership remain unchanged.

The private helper uses NDJSON stdin/stdout:

- Start with the managed model directory; emit `{"ready":true}` only after local graph/weights/tokenizer load.
- Requests are `{"text":"...","voice":"alba"}`.
- Emit sample-aligned signed 16-bit little-endian mono PCM at 24 kHz as base64 `pcm` frames, bounded to 65,536 decoded bytes, then `{"done":true}`.
- Fail with a generic `error`, never source text or audio diagnostics. Unexpected replies, invalid PCM and subprocess exit fail the active request.
- Canceling inference kills the worker; the next request explicitly reloads it. Scoped teardown closes warmed processes. Callback-producer failure explicitly fails its output queue so RPC cannot hang.

The selected model is 8-bit on disk. The helper rebuilds quantized modules using the pinned checkpoint metadata, preserves heterogeneous FlowLM module arrays, and dequantizes only the conditioner embedding in memory because the pinned quantized embedding cannot handle Pocket's zero-token conditioning.

## Build and size

`pnpm build:speech` builds `native/speech/Package.swift` with the checked-in resolution and copies the helper, resource bundles and licenses beside native dictation output. It strips local linker symbols without removing Swift runtime metadata. Full Electron builds run both native builders.

The MLX C++ core is 0.31.1. Its exact matching Metal shaders are extracted from a checksum-verified official `mlx-metal` wheel during the build, avoiding a requirement for the separately installed Metal compiler. No Python interpreter or wheel dylibs ship or run. Builder network access is distinct from runtime/model installation.

The **141 MB button describes model data only**. The native engine is bundled with Cake: on the current release build the stripped helper is approximately 28 MiB and `mlx.metallib` approximately 102 MiB, plus small resource/license files. These are unpacked sizes, not compressed application-download estimates. Release packaging/signing/notarization must include all native assets outside any executable-inaccessible archive, like dictation.

## Current limitations

- English, Alba, normal speaking speed only; no voice cloning or per-call voice overrides.
- The pinned Swift API generates a whole phrase before emitting PCM. Playback can begin before the complete assistant answer, but this is **not** upstream Pocket's incremental within-phrase streaming.
- 8-bit is a conservative starting point versus 4-bit, not demonstrated quality parity with unquantized weights. The smaller checkpoint is not offered without comparative listening/evaluation.
- Native integration verifies valid non-silent audio, not intelligibility, naturalness or quality equivalence. Physical audition and release-package validation are separate checks.

## Verification

Fast tests cover pinned/corrupt/canceled downloads, old-model preservation, Service lifecycle and queued removal, provider routing without cloud fallback, schema-valid observations, real Root/Stores/settings workflows, and local-ready/unready conversation entry. Electron smoke fixtures replace native inference/model assets but retain real main services, installation inspection, RPC, controls, typing, capture and playback.

Opt into actual offline inference with explicitly supplied model files:

```sh
pnpm build:speech
CAKE_SPEECH_TEST_MODEL=/path/to/model pnpm test:integration tests/integration/pocket-tts-native.test.ts
```

This validates bundled helper/resource loading, bounded non-silent 24 kHz PCM, cancellation and a subsequent fresh worker. It downloads nothing and uses no microphone or billed provider.
