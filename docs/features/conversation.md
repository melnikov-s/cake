# Conversation presentation and input

Pi is the sole transcript and runtime-message authority. Cake projects the complete
active branch for display, including compaction timeline entries; compacted model
input is not display history. Consecutive reminder/custom-message context pills
wrap horizontally, and removed context after Tool Compact is labeled historical.

## Shared renderer owners

Primary Project and Cake Chat surfaces compose `ConversationSessionStore` with
stable `ChatStore`, `ConversationComposerStore`, and `ChatConfigurationStore`.
Materialized primary chats use the `sessionChats` operation boundary addressed by
globally unique Pi Session ID; kind-specific parents supply creation/restoration
context, not forwarding conversation APIs. Secondary chats compose `ChatStore`
directly. Every surface uses the authoritative `Chat` component.

Composer children own coherent persisted unsent drafts/focus requests
(`ComposerDraftStore`), transient editable follow-ups and settled-turn draining
(`PromptQueueStore`), optimistic projection and correlated recovery
(`ConversationDeliveryStore`), and saved-draft activation UI
(`PendingSessionDraftStore`). Submission is serialized at shared `ChatStore`.

`TranscriptInteractionStore` owns restoration, message navigation, changed-files
disclosure, loading duration, and user-message presentation mutations.
`WorkLogPresentationStore` owns disclosure preferences, elapsed time, and its
interval. `ScheduledMessageInteractionStore` owns countdown/cancellation and its
interval. These children share ChatStore lifetime and persist nothing.

## Tool Compact

`/toolcompact` targets the latest completed assistant response. It appends a root
branch replaying user-authored input and assistant text without tool activity,
reasoning, injected reminders, custom messages, or coordination. It retains Pi
Session ID, Working Directory, and title; the original tree remains inspectable.
It has no per-message action or destination dialog.

Orientation/provenance is non-context Pi metadata. When ordinary fork extraction
cannot carry an inactive branch referenced by provenance, the Pi adapter appends
reconstructed compacted work logs as a schema-validated hidden custom entry.
Display consumes it; model context does not.

## Queued inputs and commands

Cake overlays Pi `queue_update` state while steering/follow-up messages wait and
removes them when Pi consumes their ordinary user message. User and cross-session
inputs share this queue. Steering appears first, then follow-ups, with sender-neutral
ordering within each lane. Promotion appends to steering; explicit send-now
interrupts and sends only the selected input while preserving the remainder.

Pi exposes whole-queue clearing. Single-item removal, promotion, or reordering
therefore replaces the queue through Pi queue-only primitives, preserving payloads
and delivery kinds even if the response settles. Stable identities and original
editable payloads are process-lifetime adapter metadata, not persisted transcript
copies. Hidden `cake.turn-handoff/v1` metadata records an interrupted assistant's
timestamp so send-now's partial output stays visible without a provider-failure
notice, including after reopening.

`sessions.queue-command` puts queueable slash commands in the same ordered
follow-up lane as transient adapter intents, not user messages. `/compact` and
`/toolcompact` run only between responses; the latter chooses its target at
execution time. Live extension/template/skill commands may also queue; unsupported
built-ins reject rather than reaching the model. Acceptance reports queued, not
completed. Commands have stable process-lifetime identities/part IDs for inspection,
reordering, cancellation, and send-now, but cannot enter steering.

The runtime queue-edit gate serializes replacements. Accepted commands retain a
runtime lease until execution or cancellation settles. Stop preserves pending
commands; clear/disposal cancels them. Failure is a notice. The command queue does
not survive restart.

## Schedules and coordination

Cake persists a cancellable schedule until its deadline and projects pending intent
beside the destination composer. At delivery it restores the Session if necessary,
submits an ordinary prompt (or follow-up if busy), then relinquishes message
authority to Pi. Validated origin metadata in that user message carries creation
and firing provenance to model, transcript, and queue without a second text record.

`SessionCoordinationStore` binds two participants, message/thread IDs, an optional
message limit, and closure. `accepted` means Cake/Pi accepted input; `queued` waits
as Pi follow-up; `processing` has entered a turn; `answered` means the turn settled
with projected response. Closing forbids further coordinated replies but does not
abort unrelated work. An uncancellable late arrival stays visibly attributed to
the closed exchange and never autonomously continues it. Full family communication
uses the [Session Family contract](../architecture/session-family-contract.md).

## Provider retries

The Pi adapter retries empty pre-output rate-limit responses and protocol-valid
successful responses with no content using the exact same request and bounded
exponential backoff over 24 hours. Each wait appears in the conversation. The turn's
abort signal cancels requests and waits through ordinary Stop.

Never replay after text, reasoning, or tool output begins. Failed attempts and
hidden continuation messages are not persisted. Quitting ends this in-memory
policy. Pi's native retries remain authoritative for other transient failures.

## Scrolling

`use-stick-to-bottom` owns following in Chat and independently in expanded work
logs. Sending scrolls to bottom; streaming follows when at/near bottom. Scrolling
up permits history browsing; returning near bottom resumes the library threshold.
Message navigation stops following before moving to its target.

Virtuoso owns virtualization and initial restoration, not a competing follow loop.
Scroll state is container-local, not Store/Model state. Resizing is best-effort,
not a reason to add custom machinery. This policy is shared across every Chat.

## Verification

- [Queue workflow](../../tests/app/renderer/prompt-queue-workflow.test.tsx)
- [Queued commands](../../tests/app/services/pi/queued-session-commands.test.ts)
- [Tool compaction](../../tests/app/agent/session-tool-compaction.test.ts)
- [Electron queue input](../../tests/electron/queued-messages.smoke.spec.ts)
- [Compacted work logs](../../tests/electron/tool-compacted-work-log.smoke.spec.ts)
