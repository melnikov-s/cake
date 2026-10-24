# Reports and review decisions

Read when handling worker reports, session results, summaries or pending review decisions. Delivery selection and batch timing belong to `communication.md`; to-do source links and closure belong to `chat-todos.md`.

Answer the user's message first, including after interrupted report handling. Application-rendered completion links need no assistant relay. Explain results when useful; distinguish ready, blocked and investigation. Notifications, reports and suggestions never authorize mutations.

## Retained private-worker reports

Quiet private-worker reports and passive references remain in `sessions.reports` until explicitly handled, independently of Pi input admission. Answer the user first, then emit at most one concise grouped notice at a natural boundary (defer if disruptive). After emitting the notice as assistant text, call `sessions.reports.acknowledge` with the report IDs, disposition `communicated`, and exact already-emitted `communicatedText`. Never acknowledge a future final answer, receipt, tool output or unrelated reply. Use `dismissed` only for an explicit user dismissal. The backend checks persisted visible text, not semantic adequacy; acknowledgment is your attestation. Omission, failure and interruption retain the obligation. A new report joins the pending batch once; subsequent real user turns carry bounded reminders until it is handled. `sessions.reports` pages metadata and `sessions.reports.read` reads bounded handoff slices without handling them. Inline reports are supplied evidence; linked originals remain uninspected until read. Detailed worker history stays with Pi. This reporting acknowledgment is distinct from `sessions.completions.update`, which records user decisions about delegated Project Sessions.

## Project Session decisions

New delegated Project Session results are also retained in sessions.completions, independently of execution continuation. The application displays notification-mode completion links with the next real user message or the batched turn that delivers them, without requiring an assistant relay. Answer the current question first; explain results only when useful, not merely to duplicate the notification. Distinguish ready, blocked, and investigation results; mention pending review/merge/resolve/next-step decisions without acting on them. Delivery never authorizes mutations. Page with offset/limit/query; nextOffset retrieves more. Use sessions.completions.update only to record the user’s pending/deferred/handled/dismissed decision, without nagging or rearming notices. Exact reports remain in Pi history.

For a launch roster, use `sessions.list` with `projection: "workflow"`; read `session-discovery.md` for scope and fields. Unknown readiness is not merge approval. Read relevant full reports through `messages.list/read`, not by waking the producer. `sessions.completions.update` records a user's decision, never performs merge/resolve.

## Presenting sources

When summarizing a delegated response, include its exact result-message link labeled **Full agent response**. Use the canonical report `ref` to navigate the originating conversation, never the internal reminder entry that embeds serialized report text. Private Pi IDs are provenance, not public navigation. Cake also offers an optional inline source preview. Use `messages.present` only for explicit standalone source presentation. Never copy reports into artifacts or silently substitute a newer message. Presentation does not prove you read the source or attachments. Read `presentation.md` before presenting links or rich output.
