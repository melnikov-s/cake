# Conversation mode

Conversation mode is opt-in for existing writable Project Sessions in Cake desktop. It keeps the same Pi session, model, context, tools and transcript; there is no agent-callable speech tool or second conversational LLM.

## Setup and use

1. Install/select local Parakeet in **Settings → Dictation** ([requirements](dictation.md)). Apple Silicon and macOS 14+ are required. Nothing downloads automatically.
2. In **Settings → Speech output**, save your own ElevenLabs API key, explicitly load voices and choose a voice. Cake uses Flash `eleven_flash_v2_5` with ordered 24 kHz PCM streaming. No generated preview is requested.
3. In an existing Project Session, choose **Enter conversation mode**, then wait for **Listening**. Subsequent ordinary spoken and typed messages receive brief natural spoken-response guidance. Code and detailed tables stay visible in chat.
4. Speak continuously, then pause. Sustained speech starts capture; about 900 ms quiet finalizes it. A successful nonempty utterance sends exactly once, independently of the typed draft, pending files and annotations. A busy session receives ordinary queued follow-up input, never an implicit steer or abort.
5. **Mute input** stops capture and discards unfinished speech while accepted work and output continue. **Exit conversation mode** restores text-oriented subsequent submissions. Window blur, selection changes and disposal exit automatically. Dictation activation exits conversation mode and vice versa in the same window; neither is restored automatically.

Speech onset immediately silences playback and cancels pending synthesis, not Pi/tool work. The interrupted answer remains readable but stays unspoken until Pi actually consumes a new user input. Queuing an input alone does not lift that suppression. Mode entry never replays history or an already-running response.

## Privacy and billing

Microphone audio and Parakeet inference stay local. Audio buffers are memory-only; mode and audio are not persisted. Accepted recognized text becomes ordinary Pi transcript input and follows the active model/provider's usual policy.

Only selected assistant prose is sent to ElevenLabs—not microphone audio, reasoning, tool logs or the complete transcript. Provider retention depends on the account plan; Cake does not promise zero retention. Your ElevenLabs quota/billing is separate from chat billing. Free-tier availability is neither unlimited use nor a commercial license. Cake never upgrades plans, retries billed synthesis automatically, or silently substitutes cloud STT/local TTS.

Native main stores the API key encrypted using Electron safeStorage in `<Electron userData>/speech-output/settings.json`, rejecting unavailable encryption and insecure `basic_text` storage. Only configured/not-configured and the selected voice cross RPC. The masked transient key draft clears after save/remove/disposal. Remote-backend desktop sessions still use this desktop's local speech services; browser/headless clients reject native speech operations and do not offer conversation controls.

## Coordination and limitations

`ConversationModeStore` owns window-local VAD, capture, serial recognition/finalization/submission, transcript-derived raw cursors, phrase queues and playback cancellation. Main still owns Pi and secure speech storage. Response mode is captured per submission and carried through Pi queues, compaction, reordering and send-now; exact Cake reminders remain in Pi input but are removed from display, editable queues, titles and continuation source text.

Manually typed slash skills or prompt templates while conversation mode is active may miss the response-style instruction. Only assistant replies are spoken; normal spoken conversation flow is unaffected.

The energy/sustained-speech gate uses short preroll, bounded eight-second unprocessed audio and 30-second utterance limits. Browser echo cancellation/noise suppression help, but this is not phone-grade full duplex. Use headphones if speaker leakage triggers capture. Parakeet latency, physical microphone tuning, phrase seams and voice quality remain device/account dependent.

Only stable new assistant prose is spoken. Fenced code, tables, reasoning, errors and tools are skipped. Links use labels rather than URLs. Live-to-settled render identity and absolute raw offsets prevent repeat playback. Phrase requests are serial, bounded to 2,000 characters, and audio playback schedules at most five seconds ahead, starting before the complete answer arrives.

Configuration, permission, recognition backlog and provider failures stop optional voice resources with an actionable error, leaving text chat and accepted agent work available. Unaccepted recognized text remains visible for manual recovery. Fix the cause and explicitly re-enter; no automatic retry or fallback occurs.

## Verification

Focused domain, queue, real Root/Model/Store/shared Chat workflow and playback tests use controlled external boundaries. Isolated compiled Electron smoke tests prove native inputs/Select, retained typing and enabled submission, real microphone/worklet capture, streaming playback and blur cleanup without credentials, downloads or billed requests. Deterministic fakes do not prove physical-microphone quality, real provider availability/quotas or voice quality; live validation needs explicit consent.
