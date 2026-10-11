# Conversation mode: setup and troubleshooting

Conversation mode uses the existing writable Project Session in Cake desktop,
including its model, tools and transcript. It is not a separate conversational LLM.

## Setup and use

1. Install/select local Parakeet in **Settings → Voice & Dictation**. See
   [dictation requirements](dictation.md). Apple Silicon and macOS 14+ are required;
   models do not download automatically. Voice mode does not require the Dictation
   preference to be enabled.
2. Under **Speech output**, select either [Pocket TTS (local)](local-speech-output.md)
   and download its model, or **ElevenLabs**, supplying your own API key and selecting
   a voice. Each provider retains its speed setting; there is no automatic fallback.
3. Enter conversation mode in an existing Project Session and wait for capture readiness.
4. Speech updates the normal composer. A quiet pause after recognized speech arms
   automatic sending of the **complete composer, including typed text and attachments**.
   Resume speaking to reset the countdown, or click the ear during the countdown to
   cancel sending without clearing the draft. Busy sessions queue ordinary follow-up input.
5. Outside the countdown, the ear mutes input without stopping accepted agent work or
   speech output. Exit voice mode to return to ordinary text interaction. Window blur
   or session changes exit automatically; focused-field dictation can resume if enabled.

A confirmed spoken interruption stops playback, not Pi/tool work. Short acknowledgments
may be ignored while the agent speaks. Interrupted answers remain readable. Voice mode
speaks new assistant prose rather than replaying history, code blocks or tool output.

## Speech input and text processing

Use **Speech input** settings to tune detection sensitivity and advanced send/interruption
controls. Settings label which controls apply to both dictation and voice mode. Changes
apply to the next capture: refocus a writing field or exit/re-enter voice mode.

Stricter detection can reject more noise but also miss quiet speech. It cannot reliably
separate a hallucinated short word from a genuine short reply. Use a closer/directional
microphone, reduce excessive input gain, or use headphones if speaker leakage triggers
capture. Browser echo cancellation is not a guarantee of full-duplex audio quality.

**Text processing** chooses Raw, Local punctuation or Utility cleanup. See
[processing privacy and setup](dictation.md#text-processing-three-exclusive-modes).
Gray spoken text is provisional; typed text remains ordinary composer content.
Review important dictated instructions before sending.

## Privacy and billing

Microphone audio and Parakeet recognition stay local. Accepted text becomes normal Pi
input and follows the selected chat provider's policy. Utility cleanup may separately
send the spoken insertion to the configured utility provider and incur costs.

Pocket TTS synthesis is offline after installation. ElevenLabs receives selected assistant
prose, not microphone audio, reasoning, tool logs or the full transcript. Retention and
quota depend on the account plan; free-tier access is not unlimited use or a commercial
license. Cake does not silently switch providers or automatically retry billed synthesis.

The ElevenLabs key is encrypted using Electron safeStorage in
`<Electron userData>/speech-output/settings.json`; insecure/unavailable encryption rejects
persistence. Remote-backend desktop sessions use the viewing desktop's speech services.
Browser/headless clients do not offer native conversation mode.

## Troubleshooting and diagnostics

Missing native engines in a slim build are expected: use a full build only when local
native speech is needed. For microphone permission and model setup, see [dictation](dictation.md).
After configuration, permission or provider failures, fix the cause and explicitly
re-enter voice mode. Normal text chat and accepted work remain available.

Use **Settings → Voice & Dictation → Copy voice diagnostics** after an attempt. Window-local
metadata is also logged under `[cake.voice]`; it records capture/playback transitions,
phrase lengths, timing and audio scheduling, not conversation text, credentials or PCM.
The trace clears on reload. Error details may additionally include unaccepted recognized
text, so inspect them before sharing.

For ElevenLabs synthesis failures, native main retains the latest private report at
`<Electron userData>/speech-output/last-failure.json`. It includes timing, failure reason,
validated provider request metadata and byte/chunk counts, but no key, voice ID, spoken
text, response body or audio. Check its timestamp: cancellation or a later success does
not replace an older failure. Report that file and the approximate failure time.

Nonzero scheduled samples prove audio scheduling, not that the OS output device is audible.
Check system volume and output selection. Diagnostics do not download models, synthesize
preview audio or retry a provider. Physical microphone quality and paid-provider availability
require explicit live validation, not inference from deterministic tests.
