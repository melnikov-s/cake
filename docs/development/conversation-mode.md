# Conversation mode

Conversation mode is opt-in for existing writable Project Sessions in Cake desktop. It keeps the same Pi session, model, context, tools and transcript; there is no second conversational LLM. Agent controls can inspect the saved voice list and change the desktop's default voice.

## Setup and use

1. Install/select local Parakeet in **Settings → Dictation** ([requirements](dictation.md)). Apple Silicon and macOS 14+ are required. Nothing downloads automatically.
2. In **Settings → Speech output**, save your own ElevenLabs API key, refresh voices and choose a voice. The voice list persists across restarts; refresh again only when you want an updated list. Speaking speed is saved here too, from normal (1×) to faster (1.2×). Cake uses Flash `eleven_flash_v2_5` with ordered 24 kHz PCM streaming. No generated preview is requested.
3. In an existing Project Session, choose **Enter conversation mode**, then wait for **Listening**. Subsequent ordinary spoken and typed messages receive brief natural spoken-response guidance. Code and detailed tables stay visible in chat.
4. Speak continuously: recognized words update the composer live, like dictation. After one second of quiet, a circular ring appears over the ear and fills over the next two seconds. Three seconds of quiet sends the complete composer, including typed text, files and annotations, through its normal submission path. Resuming speech hides the ring and resets the countdown, including the one-second hidden delay. Click the ear during the countdown to cancel sending without muting or clearing the draft; resume speaking to rearm the next pause. A busy session receives ordinary queued follow-up input, never an implicit steer or abort.
5. **Mute input** (outside a countdown) stops capture; text already transcribed stays in the composer while accepted work and output continue. **Exit conversation mode** restores text-oriented subsequent submissions. Window blur, selection changes and disposal exit automatically. Voice mode suppresses dictation only in that composer; the global Dictation mode preference remains unchanged. On exit or session switch, focused-field dictation resumes automatically. Focusing a different dictation-enabled writing field exits voice mode to hand back the shared recognizer.

While the agent is speaking, detected speech is tentative: playback and synthesis continue until Parakeet recognizes at least four words within three seconds of detection, or a leading **stop** or **wait** command (optionally preceded by **please**). Recognition, not sound onset, confirms the interruption. Short acknowledgments such as “okay,” “all right” and “oh, I see” are discarded when the utterance ends or the window expires; they never become queued messages. Timed-out speech stays rejected until a quiet boundary, and late recognition cannot interrupt. A short response while the agent is quiet is accepted normally.

A confirmed interruption silences playback and cancels pending synthesis, not Pi/tool work. The full captured utterance is submitted once after final recognition. The interrupted answer remains readable but stays unspoken until Pi actually consumes a new user input. Queuing an input alone does not lift that suppression. Mode entry never replays history or an already-running response.

## Privacy and billing

Microphone audio and Parakeet inference stay local. Audio buffers are memory-only; mode and audio are not persisted. Accepted recognized text becomes ordinary Pi transcript input and follows the active model/provider's usual policy.

Only selected assistant prose is sent to ElevenLabs—not microphone audio, reasoning, tool logs or the complete transcript. Provider retention depends on the account plan; Cake does not promise zero retention. Your ElevenLabs quota/billing is separate from chat billing. Free-tier availability is neither unlimited use nor a commercial license. Cake never upgrades plans, retries billed synthesis automatically, or silently substitutes cloud STT/local TTS.

Native main stores the API key encrypted using Electron safeStorage in `<Electron userData>/speech-output/settings.json`, rejecting unavailable encryption and insecure `basic_text` storage. Only secret-free settings (configured/not-configured, selected voice, speed and saved voice list) cross RPC. Changing/removing the API key clears the account-specific voice list while preserving the selected voice and speed. The masked transient key draft clears after save/remove/disposal. Remote-backend desktop sessions still use this desktop's local speech services; browser/headless clients reject native speech operations and do not offer conversation controls.

## Agent voice controls

`settings.speech.get` returns secret-free settings and the persisted voice list without a network call. `settings.speech.refresh-voices` explicitly refreshes and persists that list. `settings.speech.set-voice` selects an ID from it, changing the desktop default for subsequent synthesis. Already playing/queued audio is unchanged. These controls target the designated originating desktop like other native settings; they do not generate preview audio or implement per-character/per-call voice overrides.

## Coordination and limitations

`ConversationModeStore` owns window-local VAD, capture, tentative interruption decisions and their capture-scoped deadlines, serial recognition/finalization/submission, transcript-derived raw cursors, phrase queues and playback cancellation. Candidate timers are cleared on confirmation, rejection, mute, exit and disposal; rejecting speech does not cancel or restart the native recognizer. Main still owns Pi and secure speech storage. Response mode is captured per submission and carried through Pi queues, compaction, reordering and send-now; exact Cake reminders remain in Pi input but are removed from display, editable queues, titles and continuation source text.

Manually typed slash skills or prompt templates while conversation mode is active may miss the response-style instruction. Only assistant replies are spoken; normal spoken conversation flow is unaffected.

The energy/sustained-speech gate uses short preroll, bounded eight-second unprocessed audio and 30-second utterance limits. Browser echo cancellation/noise suppression help, but this is not phone-grade full duplex. Use headphones if speaker leakage triggers capture. Parakeet latency, physical microphone tuning, phrase seams and voice quality remain device/account dependent.

Only stable new assistant prose is spoken. Fenced code, tables, reasoning, errors and tools are skipped. Links use labels rather than URLs. Live-to-settled render identity and absolute raw offsets prevent repeat playback. Phrase requests are serial, bounded to 2,000 characters, and audio playback schedules at most five seconds ahead, starting before the complete answer arrives.

Configuration, permission, recognition backlog and provider failures stop optional voice resources with an actionable error, leaving text chat and accepted agent work available. Unaccepted recognized text remains visible for manual recovery. Fix the cause and explicitly re-enter; no automatic retry or fallback occurs.

## Speech diagnostics

Native main writes a structured console warning and replaces `<Electron userData>/speech-output/last-failure.json` on synthesis failure. This private, bounded report survives restarting Cake and contains only the latest failure: timestamp, elapsed milliseconds, failure reason/kind, HTTP status, validated content type/provider request ID, received chunk/byte counts, largest chunk size, emitted byte count and whether a sample byte was left over. It contains no API key, voice ID, spoken text, response body or audio. Diagnostic write failures do not change the synthesis error or trigger a retry. Cancellation and successful synthesis do not overwrite the last failure.

For `invalid-audio`, `unexpected-content-type`, `empty-stream` and `incomplete-sample` distinguish the checks. HTTP read sizes are arbitrary: large network chunks are split into sample-aligned PCM frames of at most 65,536 bytes, not treated as corrupt audio. Give the report and the approximate time of the failure when debugging; an older report may describe a previous attempt.

## Verification

Focused domain, queue, real Root/Model/Store/shared Chat workflow and playback tests use controlled external boundaries. Isolated compiled Electron smoke tests prove native inputs/Select, retained typing and enabled submission, real microphone/worklet capture, streaming playback and blur cleanup without credentials, downloads or billed requests. Deterministic fakes do not prove physical-microphone quality, real provider availability/quotas or voice quality; live validation needs explicit consent.
