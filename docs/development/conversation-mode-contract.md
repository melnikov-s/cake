# Conversation mode — proposed implementation contract

**Status: review skeleton; awaiting explicit user approval. No implementation children started.**

Base checkout: `d479baf5b8334783d61b565341bec100dc97935f`.
The immutable review patch published with this proposal is the reproducible approval baseline;
this document is not permission to implement until the user approves it. Named TODO/fixme cases
and throwing method bodies are deliberately incomplete, not passing feature verification.

## Product contract

- Opt-in **conversation mode for existing, writable Project Sessions on desktop**. No new chat,
  session, model, agent loop, transcript store, or standalone agent-callable speech tool.
- Parakeet input stays local, reusing the installed model, native worker and microphone adapter.
  Current Parakeet requirements remain Apple Silicon/macOS 14+. No automatic download.
- ElevenLabs output uses the user's own API key and selected voice, initially
  `eleven_flash_v2_5`. Only selected assistant prose is sent to ElevenLabs, not microphone audio,
  reasoning, tool output or the full transcript. Cloud retention follows the user's provider plan;
  do not promise zero retention. Free-tier availability is not unlimited use or a commercial license.
- Enter prepares capture/playback and marks **subsequent submitted turns**, including typed turns,
  as `responseMode: "voice"`. It does not alter the instructions of an already-running turn.
  Exit makes subsequent submissions text-oriented. No permanent system-prompt mutation.
- Voice guidance is defined in `conversation-response-mode.ts`: brief natural replies, short
  explanations, follow-ups when useful, existing tools/context, code and detailed tables in chat.
- The normal shared Chat remains visible. Its composer, model selection, tools, typed draft,
  pending attachments and annotations retain their current owners and behavior.
- Hands-free: sustained speech starts an utterance, silence finalizes it, and a nonempty successful
  final transcription submits exactly once. Silence/noise/empty recognition do not send anything.
  Recognized speech is delivered as a separate ordinary input, **without consuming the typed draft,
  attachments or annotations**. Speech submission cannot activate a saved/deferred draft session.
- Idle speech uses the existing prompt operation. While busy it uses Pi's ordinary follow-up
  behavior; it does not silently steer or abort work. Existing manual queue controls remain usable.
- Synthesized output starts at stable phrase boundaries before the full answer completes. Only
  new assistant text attributable to inputs consumed after mode entry is eligible. Do not replay
  history, output already running on entry, old branch content, reasoning, errors or tool logs.
- Speech onset immediately stops playback, cancels synthesis and discards pending phrases from
  that reply. Tools/Pi work continue. Its remaining output stays suppressed until a new user input
  is consumed by Pi, not just optimistically shown or queued. Preserve interrupted text in chat;
  do not rewrite Pi history to pretend the audio was heard.
- **Mute is input-only:** stop capture and discard the unfinished utterance; output and accepted
  work can continue. Exit, project/session switch, window blur and disposal stop capture/output,
  invalidate late callbacks, release local inference, and never cancel accepted or queued Pi work.
- Dictation and conversation capture exclude each other **within the same window**. Entering
  conversation disables dictation before preparing Parakeet; enabling dictation exits conversation
  first. Do not automatically restore a previous mode on exit. Do not redesign cross-window worker
  ownership as part of this feature.
- No automatic synthesis retry, replay on reconnect, generated preview audio, paid-tier upgrade,
  cloud STT fallback, local TTS fallback, voice cloning or alternative conversational LLM.

## Authority, ownership, lifetime and concurrency

| Concern                                            | Authority / cohesive owner                                                 | Lifetime / persistence                                                     | Concurrency                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Transcript, model and tool work                    | Existing Pi runtime                                                        | Existing Pi JSONL                                                          | Existing Pi admission and queue policy                                                                    |
| Response style                                     | Submission intent carried by shared conversation delivery                  | Exact Cake reminder in Pi input; stripped only from presentation           | Captured per input, never a mutable global mode read when queued input executes                           |
| Key and selected voice                             | Native main `ElevenLabsSpeech`                                             | Desktop-private speech settings; key encrypted with Electron `safeStorage` | Serialized settings mutations; current-first ordered secret-free settings observation                     |
| Provider request                                   | `ElevenLabsSpeech.synthesize` stream                                       | Request/subscriber Scope; text/audio only in memory                        | One request per phrase; cancellation closes request; no retries                                           |
| Settings interaction                               | Window `SpeechSettingsStore`                                               | Projection and transient drafts, no snapshots                              | One mutation at a time; latest voice refresh wins; stale completion cannot overwrite                      |
| Conversation, utterance, speech cursors and timers | Window `ConversationModeStore`                                             | One active Project Session, ephemeral                                      | Serial recognition/finalization/submission; serialized phrases; generation guards for every late callback |
| Local inference/model                              | Existing main `Dictation`                                                  | Existing warm worker lifecycle                                             | Existing single-inference serialization; no replacement recognizer                                        |
| Microphone                                         | Existing browser `Microphone`, owned by conversation workflow while active | Capture only; no recordings                                                | One capture in this window; utterance boundary does not require reopening device                          |
| Playback                                           | Browser `SpeechPlayback`, owned by conversation workflow                   | Web Audio context/nodes while active                                       | Ordered PCM scheduling, at most five seconds scheduled ahead; stop synchronously invalidates old audio    |
| Controls                                           | Shared Chat + UI primitives                                                | Mounted UI                                                                 | Store intents; no component-owned async workflow                                                          |

## Shared interfaces and delivery cutover

The code diff contains the actual destination contracts:

1. `SessionChatPromptInput.responseMode?: ConversationResponseMode` (`text | voice`). Omission means
   text, not inheritance of historic voice mode. Shared transport and admission use the same field.
2. Add the same optional response-mode argument at the **end** of `CakeSessionHandle.prompt`,
   `steer`, `followUp`, `editMessage` and the corresponding runtime/turn-controller functions.
   Do not disturb existing positional `automaticTitle` or `presentationMode` arguments.
3. Add `responseMode` to `ConversationDeliveryInput`; optional `responseMode()` capability flows
   through ProjectSessionStore → ConversationSessionStore → ConversationComposerStore →
   ConversationDeliveryStore. Every actual submission captures the current value once.
   ProjectSessionStore supplies optional conversation-control capabilities to shared ChatStore;
   other chat kinds omit them. ChatStore exposes those capabilities without owning voice state.
4. The Project Session voice target calls the existing DeliveryStore's `send` with independently
   recognized text, no attachments, no draft restoration, ordinary prompt delivery and voice style.
   A rejected/unaccepted input remains visible as the conversation workflow's recoverable transcript.
5. Ordinary model-bound user content receives the **exact** approved response reminder only
   when the submitted mode differs from preceding Pi history and applicable queued inputs. Text
   is the initial default, so initial/repeated text and repeated voice inputs need no reminder.
   A voice transition introduces spoken-response guidance; returning to text explicitly overrides
   it. Recover the previous mode from exact reminders on the active Pi branch, not a persisted
   Cake flag. Tool Compact removes injected reminders from replay, restoring the text default.
   Capture decorated content through queuing, compaction, edit/send-now and reordering; never consult the
   current renderer mode later. Built-ins and shell parsing keep their current routing before
   ordinary-content decoration; preserve attachments and cross-session metadata.
6. `stripResponseModeReminder` is used alongside the existing presentation-mode stripping for
   display, editable queue payloads, titles and continuation source text. Remove only exact Cake
   reminders, not arbitrary user-supplied tags. Pi remains the history authority.
7. `ElevenLabsSpeechLive` requires the concrete Effect `HttpClient` and `SpeechOutputStorage`.
   The latter is a main-only encrypted-settings boundary, with `load`/`save` of
   `StoredSpeechOutputSettings`. `makeSpeechOutputStorageLive` receives FileSystem plus the approved
   `SpeechKeyEncryption` adapter supplied by desktop main's Electron `safeStorage`; its availability
   gate rejects insecure `basic_text` storage. Inject only these external boundaries in tests, not
   internal provider/coordination policy. Decrypted stored settings never cross RPC.
8. `SpeechOutputRpc` is native-only. Add the required `Client.speechOutput: SpeechOutputCommands`
   group in the implementation and migrate every adapter/fake together—no optional client group,
   compatibility facade or alternate protocol. Streaming synthesis consumes ordered chunks through
   `runtime.execute` + `Stream.runForEach`, **not** the observer's reconnect/retry policy.
9. Native settings observations use the existing common observation primitive. A focused observer
   applies them to SpeechSettingsStore; ordinary Stores import neither Effect nor RPC mechanics.
   Remote desktop routes speech output locally, as it already routes dictation; browser/headless
   clients explicitly reject native speech commands and show no conversation controls.

## Recognition and spoken-text policy

Use the existing echo-cancelled/noise-suppressed microphone PCM frames and the bundled offline
Silero detector shared with dictation. Detection runs in 256 ms frames with a 0.6 entry / 0.4
continuation speech-probability threshold, short preroll, a three-second quiet send boundary and
30-second maximum utterance. Noise loudness must not reset the send countdown; classified quiet
speech must be eligible to start an utterance and a transcript-confirmed interruption. Native
recognition separately finalizes phrases after 1.5 seconds of non-speech without submitting a draft.
No runtime VAD model download or voice-agent service is involved. Numeric tuning is an
implementation detail; the contract is no noise-only submission, prompt interruption on real
speech, bounded queues and exactly-once finalization. Headphones are recommended when speaker
leakage defeats browser echo cancellation; do not claim phone-grade full-duplex robustness.

Progressive recognition reuses `DictationAudio` with a unique utterance ID, roughly 800 ms batches,
one inference request at a time and an eight-second maximum unprocessed backlog. Finalize before
submission; pending recognition cannot submit after exit, selection change or a newer generation.
A continuous long utterance is finalized at its limit rather than silently losing audio.

`takeSpokenPhrases` consumes cumulative raw assistant prose with absolute offsets. Hold unfinished
phrases/markup, skip fenced code and tables, strip presentation markers, speak link labels rather
than URLs and flush the final prose once. Keep fence context across offsets. Every request is
at most 2,000 characters. Track existing live-to-settled presentation identity (`renderKey`/part
identity), not array position, to prevent duplicate speech when Pi settles an entry or snapshots
rebuild. Cancellation drops only ephemeral audio, never transcript text.

Provider HTTP `/v1/text-to-speech/{voiceId}/stream?output_format=pcm_24000` delivers PCM as it arrives.
Main emits bounded sample-aligned chunks; playback validates decoded bytes, applies backpressure
and drains through the final audible sample. Phrase requests are sequential; no whole-reply audio
collection. Request failure/cancellation does not automatically generate the phrase again.

## Errors and recovery

- Missing/unsupported Parakeet, unconfigured key/voice or denied microphone permission blocks
  activation with an actionable message, leaving normal text chat available.
- Invalid key, exhausted quota, rate limits, provider/network failures, malformed audio and storage
  failures use the typed `SpeechOutputError` contract. Never expose request headers, keys or raw
  provider bodies in UI/errors/logs. Distinguish quota/configuration failures without promising a
  guessed credit balance or provider pricing.
- Unavailable/insecure `safeStorage` rejects key persistence, **never** plaintext fallback.
  Optional speech setup/network failure must not prevent app startup. No network calls at startup.
- Recognition backlog/disconnection or output failure stops voice resources and shows an error;
  preserve the recognized unaccepted text for manual recovery. The existing agent continues and
  its visible answer remains usable. Retry requires explicit re-entry after fixing the cause.
- Exiting during preparation, finalization, provider streaming or playback invalidates late results;
  a new generation cannot inherit their PCM or submit to a different session.

## Exact proposed file ownership after approval

Use shared checkout children (no independent worktrees unless the assignment is revised). The
following is a proposal, not launched assignments. Parent owns decisions and the coordination
artifact; it does not implement, routinely review, or execute checks after approval.

### Child A — native ElevenLabs boundary (independent)

Own complete files:

- `src/services/speech/speech-output-data.ts`
- `src/services/speech/ElevenLabsSpeech.ts`
- `src/services/speech/ElevenLabsSpeechLive.ts`
- `src/services/speech/SpeechOutputStorage.ts`
- `src/services/speech/SpeechOutputStorageLive.ts`
- `src/ipc/protocol/SpeechOutputRpc.ts`
- new `src/ipc/server/SpeechOutputHandlers.ts` (thin service delegation)
- `tests/app/services/speech-output.test.ts`

Implement approved schemas, secure settings, current-first observation, voice listing, bounded
HTTP streaming, typed failures and cancellation. No renderer or main graph edits. No real paid
requests. Use deterministic injected HttpClient, SpeechOutputStorage, FileSystem and
SpeechKeyEncryption boundaries; if a new
shared/public testability interface is necessary, propose it before implementing it.

### Child B — conversation workflow, Pi integration, UI and verification

Own complete destination files:

- `src/contracts/conversations/response-mode-reminders.ts`
- `src/renderer/stores/ConversationModeStore.ts`
- `src/renderer/stores/SpeechSettingsStore.ts`
- `src/renderer/speech/playback.ts`
- `src/renderer/speech/spoken-text.ts`
- `src/renderer/components/ui/voice-conversation-controls.tsx`
- `src/renderer/components/chat-conversation-controls.tsx`
- `src/renderer/components/settings-speech-section.tsx`
- new `src/renderer/observers/speech-output.ts`
- `tests/app/domain/conversation-response-mode.test.ts`
- `tests/app/renderer/conversation-mode-workflow.test.tsx`
- `tests/app/renderer/spoken-text.test.ts`
- `tests/app/renderer/speech-playback.test.ts`
- `tests/electron/conversation-mode.smoke.spec.ts`

Own **only feature-related bodies/fields** in these existing cutover files; preserve unrelated work:

| Exact files                                                                                                                                                                                             | Authorized mechanical changes                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/ipc/conversation-data.ts`, `src/domain/conversations/conversations.ts`, `src/ipc/server/SessionChatHandlers.ts`                                                                                    | Carry response mode through existing prompt/steer/follow-up/edit admission                                                          |
| `src/services/pi/CakeSessionRuntimes.ts`, `src/services/pi/runtime/cake-session-runtime.ts`, `src/services/pi/runtime/cake-session-runtime-turn-controller.ts`                                          | Append approved optional arguments; decorate and retain input through Pi queues/compaction/edit; strip only visible payloads        |
| `src/services/pi/runtime/session-projection.ts`, `src/services/pi/runtime/session-title.ts`, `src/services/pi/runtime/cake-session-runtime-continuations.ts`                                            | Strip exact response reminders from display/title/continuation source alongside presentation reminders                              |
| `src/renderer/stores/ConversationDeliveryStore.ts`, `src/renderer/stores/ConversationComposerStore.ts`, `src/renderer/stores/ConversationSessionStore.ts`, `src/renderer/stores/ProjectSessionStore.ts` | Submission-time mode capability and draft-independent speech target; optional controls capability; preserve existing admission      |
| `src/renderer/stores/ChatStore.ts`, `src/renderer/components/chat.tsx`                                                                                                                                  | Optional conversation controls capability and composed shared toolbar; no voice workflow state or second Chat                       |
| `src/renderer/stores/RootStore.ts`, `src/renderer/stores/DictationStore.ts`                                                                                                                             | Compose focused window Stores; add optional before-enable dictation intent for mutual exclusion; reactive selected Project identity |
| `src/renderer/stores/SettingsStore.ts`, `src/renderer/components/settings-page.tsx`, `src/renderer/lib/settings-search.ts`                                                                              | Add Speech output page and search terms, reusing primitives                                                                         |
| `src/renderer/client/Client.ts`, `src/renderer/client/ClientLive.ts`, `src/ipc/client/CakeIpcClient.ts`                                                                                                 | Required typed speech group; cancellation-aware single-execution stream consumer; browser native rejection                          |
| `src/ipc/protocol/CakeRpc.ts`, `src/ipc/server/CakeRpcServer.ts`, `src/main/MainLive.ts`, `src/main/RemoteMainLive.ts`, `src/renderer/runtime.ts`                                                       | Native-only RPC/service wiring, desktop-private settings directory, remote local speech routing; no backend graph acquisition       |
| `src/renderer/main.ts`                                                                                                                                                                                  | Settings observer lifecycle; window-blur exit and teardown; no background capture                                                   |
| `src/renderer/components/ui/icons.tsx`, `docs/development/component-catalog.md`                                                                                                                         | Reuse existing microphone/stop icons or add only genuinely missing icons; catalog shared controls                                   |
| `tests/app/renderer/test-client.ts`, `tests/app/renderer/renderer-store-fixture.ts`, `tests/electron/main-harness.ts`, `tests/electron/rpc-harness.ts`                                                  | Required typed fake/fixture group provisioning only; no generalized transport redesign                                              |
| `tests/app/services/pi/cake-session-runtime-turn-controller.test.ts`                                                                                                                                    | Fill approved response-mode cases; retain existing queue and command coverage                                                       |
| `docs/development/dictation.md`, new `docs/development/conversation-mode.md`                                                                                                                            | Explain mode use, settings, privacy/billing, microphone lifecycle and limitations                                                   |

Child B owns all shared cutover/wiring; do not let both children edit shared files. Wait for A's
settled service contract before final integration checks. Run formatting and required checks,
report checked revision/state, commands, results, gaps and compact failure evidence. Raw logs
remain with the child. A separate non-implementing reviewer child inspects the settled actual
diff against the immutable approval baseline, accepted scope expansions and approved amendments.

Additional callers/fixtures discovered without changing behavior/interfaces require a compact
mechanical scope request. Changes to interfaces, authority, lifetime, failure policy or tests
require a proposed small contract/test-stub diff and renewed **user** approval. No silent ownership
expansion or open-ended “all remaining integration” assignment.

## Keep / extend / replace / delete and sequence

- **Keep:** Pi transcript/model/tools/queue policy, Dictation Service/native helper, model installer,
  microphone/worklet, typed composer/drafts, authoritative Chat/ChatStore, RPC/runtime infrastructure.
- **Extend:** submission style, exact-reminder stripping, native speech RPC/client group, window Store
  composition, dictation activation coordination, shared Chat controls and Settings.
- **Add:** focused output Service, conversation/settings Stores, browser playback/phrase policy,
  composed controls and tests. No standalone speech tool.
- **Replace/delete:** only review stubs/TODO/fixme markers as their real implementation lands.
  No production path is being replaced; no compatibility shims or broad moves are needed.
- **Sequence:** implement independent output boundary and renderer policy against frozen contracts;
  integrate typed clients/fakes and Pi delivery; compose Stores/observer/UI/native graphs; complete
  real regression tests; format; verify settled implementation; independent review; parent triage;
  delegate accepted fixes and recheck affected scope.

## Verification contract and uncertainties

Run focused new service/domain/renderer suites and the real existing turn-controller tests,
then relevant dictation workflow regressions. Required final checks: Oxfmt (`pnpm format`,
`pnpm format:check`), `pnpm lint:oxlint`, `pnpm lint`, `pnpm typecheck`, `pnpm build`.
No success claim for remaining TODOs/fixmes or unimplemented exported methods.

After the final build, use isolated Electron tests for new conversation/Settings controls,
real composer focus/typing/retained value/enabled submission, existing dictation,
`tests/electron/slash-command.smoke.spec.ts` and
`tests/electron/side-chat-streaming.smoke.spec.ts`. Do not run the full e2e suite by default.
Use the repository visual harness when reviewing the new controls/Settings layout.

Resolved feasibility: microphone worklet already emits fine-grained PCM frames (no worklet API
change needed); Parakeet supports progressive + final utterances; existing prompt RPC already
holds busy-session inputs; live/settled text parts expose presentation identity; ElevenLabs offers
24 kHz PCM streaming without the Pro-only 44.1 kHz format. Native speech output can follow existing
local dictation routing even when Pi lives on a remote backend.

Remaining empirical uncertainties (not alternate architectures): VAD tuning, speaker echo,
Parakeet finalization latency, voice quality/phrase seams and provider/free-quota availability on
an actual account. Deterministic tests prove coordination, not physical-microphone quality or
paid-service availability. No API credentials or real billed voice calls are required to approve
or implement the skeleton. Live listening/account validation needs explicit consent and must be
reported separately. No configured implementation model preset has been selected yet.

## P1 — native window blur (PROPOSED / NOT IMPLEMENTED)

This amendment requires explicit user approval before native emission, accepted-type routing,
observer consumption, or test implementation. The original approved behavior remains unchanged:
window blur releases conversation-mode resources without cancelling Pi work.

Evidence from an isolated compiled Electron test: `BrowserWindow.blur()` produces
`isFocused() === false`, while the renderer still has `document.hasFocus() === true` and receives
no DOM `window` blur callback. A DOM listener alone does not prove the native boundary.
Raw experiment: `/tmp/conversation-blur-experiment.log`.

Proposed data-only contract, in `src/ipc/cake-rpc-contract.ts`:

```ts
"window-blurred": Schema.Struct({ type: Schema.Literal("window-blurred") })
```

Add this declaration to both `applicationEventSchema` and `cakeEventSchema`, and add the type to
`ClientEventsService.application` and the manual `CakeIpcClientService.events.application` type
union in `src/ipc/client/CakeIpcClient.ts`. No new RPC, transcript data, persistence, session identity, or
renderer Model is introduced. Electron main is the native focus authority. Delivery is transient,
window-targeted, and not replayed; the receiving window's ephemeral `ConversationModeStore` owns
resource cleanup. Other windows and Pi tools are unaffected. Remote desktop still receives the
local native event through its local application-event channel; browser/headless do not emit it.

Proposed routing only (not implemented):

```ts
// src/services/electron/ElectronLive.ts, after registering the window connection
window.on("blur", () => {
  clientEvents.sendTo(connectionForWindow(window), { type: "window-blurred" });
});
// src/services/clients/ClientEventsLive.ts: include "window-blurred" in application accepted types.
// src/renderer/observers/application-events.ts, before generic Store event conversion
if (event.type === "window-blurred") {
  void root.conversationModeStore.exit();
  return;
}
```

Keep the existing DOM blur cleanup listener as supplemental handling. Do not broadcast native
focus loss, retry it, create a new lifecycle framework, or change microphone/Store ownership.

Proposal-only files: this document; `src/ipc/cake-rpc-contract.ts`;
`src/ipc/client/CakeIpcClient.ts` (only its manual application-event type declaration);
`src/services/clients/ClientEvents.ts`; `tests/app/services/clients/ClientEvents.test.ts`;
new `tests/app/renderer/observers/conversation-mode-events.test.ts`.
Production routing files remain read-only until approval: `src/services/clients/ClientEventsLive.ts`,
`src/services/electron/ElectronLive.ts`, `src/renderer/observers/application-events.ts`.

Named proposed tests (TODOs are explicitly not verification):

- `native_window_blur_validates_and_reaches_only_target_application_connection`
- `native_window_blur_is_not_replayed_to_late_or_other_channel_subscribers`
- `native_window_blur_releases_capture_recognition_synthesis_and_playback_without_cancelling_pi`
- `non_blur_application_events_do_not_exit_conversation_mode`
- `cancelled_event_observation_does_not_reenter_or_mutate_disposed_mode`

Use deterministic event queues with real routing and real Root/Models/Stores; fake only external
services/audio. Preserve the existing isolated Electron test's actual native `BrowserWindow.blur()`
assertion. Synthetic DOM blur cannot replace this proof. Final verification stays blocked on this
native-blur requirement until implementation is approved and tested.

### P1 approval and implementation record

The user approved the frozen [P1 review baseline r2](cake://artifact/conversation-mode-p1-review-baseline@r2)
(SHA-256 `f180884e720af9697df08e93217b09b2d54a11fd55448dab8ad07ecfdc9ff4a1`) by responding
“yeah” to the explicit P1 approval request. Approval and exact ownership are recorded in
[coordination r17](cake://artifact/conversation-mode-coordination@r17). The preceding proposal/pause
text is preserved history, not the current approval status.

Implementation follows that approved event exactly: `ElectronLive` sends native blur only to the
blurred window's registered owner, `ClientEventsLive` accepts it on the existing application
channel without replay, and `observeApplicationEvents` exits the existing window-local mode before
generic Store conversion. The data-only schema and both application type declarations match.
No new RPC, persisted state, Pi cancellation or microphone ownership was introduced; the DOM blur
listener remains supplemental.

All five named P1 tests now have real implementations. Service tests use ordered Queue barriers
for target-only, channel-specific and late-subscriber delivery. Observer workflows start the shared
Chat over real Root/Models/Stores and real event routing, with deterministic external capture,
recognition and streaming-synthesis boundaries. They check cleanup/late completions, a non-blur
control, and cancellation/disposal/reconnection. The existing compiled Electron native-blur gate
still requires actual `BrowserWindow.blur()` and `isFocused()` transitions; no synthetic DOM event
or skipped case substitutes for it. Final verification is reported separately against the settled
checkout and does not establish physical-microphone or paid-provider quality.
