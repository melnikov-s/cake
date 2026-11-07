# Delivery, batching and check-ins

Use [delivery](communication.md) for the short decision rule; this page explains correlation and evidence.

## Results versus outbound messages

resultDelivery belongs to one launch/message obligation, not an entire session. reply transports the correlated result and queues one non-interrupting normal parent continuation on application-confirmed completion; it neither steers active work nor runs beside it.
notification retains compact completion and an exact result-message link for the pending batch; ignore owes no correlated result/notice. A promised answer or dependent action uses reply, including implementation needed next.
Outbound delivery is separate: fyi is passive context with no result obligation/wake; queue is ordered future work; prompt is an immediate assignment/question. Necessary corrections can use the operation's default steering behavior.
Application owns correlation, retries and exact links; links/artifacts do not cancel the selected mode. Unrelated user-started turns do not report to a creator. Transport is deduplicated, not exactly-once generated prose.
Workboard completion is passive coordination, not satisfaction of a correlated launch reply. Do not add manual sessions.reply, private wake-up or polling to force completion. Prompt wording cannot reroute runtime obligations.
Direct questions are immediate. outcome:blocked escalates after the worker turn settles even in notification mode; ordinary notification completion/failure stays passive. Composer holds are bounded; stop-all and explicit withdrawal remain authoritative.

## Pending batches

Notifications, FYIs, routine board posts and quiet worker reports share one pending batch per conversation. The first item starts its timer; the next user message takes the batch and cancels it. Otherwise delivery is one turn within five minutes or sooner before estimated prompt-cache expiry; unknown/expired cache uses five minutes.
Busy conversations receive batches after current work, including intervening arrivals; no parallel steering. Explicit stops/interrupted-work review wait for user input. Timers/admissions survive restart and deduplicate.
A batch has no new user message. Handle obligations together, answer owed questions/blockers, and continue only authorized work. No acknowledgment, receipt echo or automatic recap is needed.
Fresh Project Chats accept FYIs/immediate handoffs before first manual open. Opening selects/loads the chat but neither sends input nor drains FYIs. Sender-attributed Markdown is not recipient-user authorship. Synthetic instructions stay in context/Pi originals rather than ordinary transcript copy.
Canceled inputs do not rearm delivery; already admitted inputs cannot be unsent.

## Receipts

ok:true means acceptance, not communication or execution. deferred + transcriptDelivery:pending means retained FYI. Immediate admission can still report transcriptDelivery/execution:unverified.
A FYI becomes accepted when Pi admits the carrying input, not when a storage marker settles. execution:not-requested means context, not assignment. Verify transcript visibility and actual effects separately.

## Private workers

subagents.start continuation:resume (default) means reply; none means notification. Both owe results and follow-ups inherit unless overridden. message_parent questions/blockers remain immediate.
Launch/follow-up asynchronously. Blocking run/parallel/wait requires an explicit user request, returns directly and needs no extra continuation.
Retained report acknowledgment is a different workflow: [reports](reports.md).

## Requested scheduling recipe

Only on explicit user request, call sessions.schedule without sessionId to target your conversation, using repeatEverySeconds for the requested durable interval.
Keep at most one pending check-in per coordinator task. Inspect sessions.scheduled; stop with sessions.cancel-scheduled at completion or pause/stop. Work or end the turn between checks; never busy-wait.
Preserve the task-scoped communication channel and explicit user overrides. Current user direction overrides Cake process defaults without an instruction-file edit or repeated approval, but not security boundaries/tool limits.
Do not claim a timer/wake/execution without confirming tool evidence. If unsupported, name the exact missing capability and supported path.
