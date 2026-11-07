# Voice and dictation settings

Use the calling desktop's settings.dictation.get/update; these are window-owned preferences, not generic backend scalar keys. No audio is exposed. [Settings](settings.md) covers authorization.

## Update controls

get returns installation/capture state, processing mode and speechInput preferences, including dictationVoiceSend and dictationSendPhrase.
At the user's request, update with {action:"voice-submit",enabled:true,phrase:"send it"}; omit phrase to preserve it.
speech-input-number uses key/value (for example minimumSpeechMs:250) with the UI's bounds, rounding and coupled limits; read effective values. short-commands uses enabled; reset-speech-input restores defaults; processing uses mode:raw|utility.
These use the UI authority and durable window snapshot. Voice-submit changes seal pending speech/restart capture; recognition tuning affects subsequent generations. Filters apply live.

## Submission matching

Submission commands must be the entire finalized recognized utterance. Quiet separation is 1.5 seconds rounded up to 256ms audio frames, not punctuation. Starting capture/editing the draft starts a fresh utterance with no extra leading wait; resumed speech restarts the quiet countdown.
Matching ignores case, outer whitespace and edge punctuation, not extra words or intent. "Send it." matches send it; "send it now" does not unless configured. Background speech may prevent isolation.
Partial recognition and cleanup cannot submit. Raw and utility modes share the rule; ordinary sentences containing the phrase remain dictation.
The command is removed before normal composer validation; empty messages cannot submit. voice-submit means submission requested, not backend acceptance.
desktop.log diagnostics contain policy, short correlation IDs, quiet durations and decision reasons, never dictated content.

## Discard filters

Read the current list first. update actions: discard-filter-add with filter:{text:"Yeah.",matchCase:true}; discard-filter-edit with zero-based index and filter; discard-filter-remove with index. Verify afterward with get.
Stored text is verbatim, 1–256 characters and not punctuation/whitespace alone. Filters match the entire finalized raw utterance at quiet/manual-finalization boundary before cleanup, never interim results, cleanup output, substrings or existing typed text.
Discard rolls interim insertion back to the pre-utterance draft/selection. Matching ignores outer whitespace and Unicode edge punctuation but preserves internal spacing/punctuation.
With matchCase true, Yeah., Yeah and “Yeah!” match Yeah.; yeah does not. With false, case is ignored. "Yeah, carry on" and "I said Yeah." remain speech. Voice-submit wins if both policies match.

## Navigate, do not toggle

settings.open {page:"voice"} opens Voice & Dictation. {setting:"dictation.voiceSubmit"} scrolls/highlights without toggling or focusing an input.
Other stable identities: dictation.submitPhrase, dictation.enabled, dictation.textProcessingMode, dictation.vocabulary, dictation.discardFilters, speechInput.detection, speechInput.advanced. Phrase highlights its parent even when submission is off.
Use settings.open.help for choices; arbitrary selectors fail. Navigation targets the caller's window and requires user-owned Allow agent session navigation. Success means navigation requested, not verified pixels or changed settings. Explain missing/headless window; never edit files or bypass permission.
