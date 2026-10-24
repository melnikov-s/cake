# Delivery and check-ins

Read before launching, sending, replying, choosing delivery, handling batches or scheduling coordination. Family members must also read `workgroups.md`; this guide does not authorize private family messages.

## Choose results separately from outbound delivery

Choose one `resultDelivery` on session launch/send:

- `"reply"`: transport the correlated result and start/queue a normal parent turn on application-confirmed completion.
- `"notification"` (default application-wide, including families): retain a compact completion and exact result-message link in the pending batch.
- `"ignore"`: owe no result or notification.

Reply when the user awaits an answer (questions, checks, investigations, diagnoses) or you will act on it next. A promised answer means reply. Use notification for background work the user will review later.

Outbound `delivery` is separate. `"fyi"` is an authorized passive update: batched, with no steering, separate wake or return-result obligation. Necessary immediate corrections omit delivery to steer active work/start an idle recipient. `"queue"` means deliberately ordered future work; `"prompt"` means an immediate assignment/question. Boards are for families only. Never acknowledge receipts, results or resolution, or relay application notifications. Explicit user exceptions apply.

A reply obligation belongs to one message, not a session. The application owns completion, correlation, retries and exact links; no manual worker completion call/relay is needed. Links/artifacts keep the chosen mode. Unrelated user-started turns never report to the creator. Transport is deduplicated, not exactly-once model prose.

Direct questions are immediate. `outcome: "blocked"` escalates after the worker turn settles, even in notification mode; ordinary completion/failure remains quiet. Composer holds are bounded; stop-all and explicit queue withdrawal remain authoritative.

## Batched delivery

Notification results, passive FYIs, routine Workboard posts and quiet worker reports share one pending batch per conversation (global Cake Chat, Project Chat or parent Project Session). The first item starts its timer. The next user message takes the whole batch and cancels the timer. Otherwise it arrives as one turn after 5 minutes, or sooner just before estimated prompt-cache expiry. Unknown/expired cache uses 5 minutes.

A batch turn has no user message: handle it together and reply once, continuing only authorized work. Never steer or run beside active work: busy conversations receive the batch after current work, including intervening arrivals. Explicitly stopped conversations or interrupted-work review wait for the next user message. Reply mode, direct questions and blockers remain immediate. Timers/admissions survive restart and are deduplicated.

Passive FYIs are typed agent-authored context, not fake user messages/raw reminder markup. Durable notice/input IDs deduplicate delivery; canceled inputs never rearm it. Preserve existing explicit result/continuation choices. Prompts/tools update on deployment; already admitted inputs cannot be unsent.

## Private workers

Launches/follow-ups are asynchronous; expecting results never means waiting. Blocking run/parallel/wait requires an explicit user request and returns directly, without extra continuation.

`subagents.start` uses `continuation`, not `resultDelivery`: `"resume"` (default) means reply; `"none"` means notification. Choose by the rule above. Both owe results; links never cancel resume. Follow-ups inherit unless overridden. `message_parent` blockers/questions remain immediate. Parents receive results through the serial queue, never steering/concurrent turns.

Workboard-only children may choose `resultDelivery: "ignore"`; posts use explicit-audience/root delivery, not a second completion grant. Independent `session.create` retains a quiet initial completion for its creator; local user/UI creation without a creator owes nothing. Read `reports.md` before handling retained reports or review decisions.

## User-requested check-ins

Current explicit task-scoped user instructions override earlier user-authored repository instructions and Cake-owned family/channel/process defaults, including injected policies. No AGENTS.md edit or repeated confirmation is needed. Genuine provider/platform/system constraints, security boundaries and actual tool capabilities still apply. Identify the concrete constraint and supported path, not a blanket "harness forbids" refusal. Confirm execution with tool evidence; posting alone proves no work began.

Do not poll or schedule periodic coordination unless the user explicitly requests it, including when completion events do not wake the coordinator. Use durable scheduling when available at the requested interval: `sessions.schedule` without `sessionId` targets your own conversation; `repeatEverySeconds` creates one recurring entry. Keep at most one pending check-in per coordinator task. Inspect with `sessions.scheduled`; stop with `sessions.cancel-scheduled` when finished or asked to pause/stop. Work or finish the turn between check-ins; never busy-wait/sleep-loop. Preserve the task-scoped communication channel, including explicit user exceptions. Never claim scheduling or a future wake without a confirming tool result; disclose missing capabilities.
