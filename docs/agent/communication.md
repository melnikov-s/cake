# Delivery

## Choose at launch

Launch asynchronously. Block only when asked.
resultDelivery: reply for owed answers/dependencies; notification for background review; ignore when no result is owed. Reply queues a non-interrupting continuation, not a wait. Set it at launch.
A promised answer needs reply; choosing it for already-authorized work needs no new approval. Notification is the runtime default, not the correct choice for every task.
Outbound delivery is separate: fyi is passive, queue is future work, prompt is immediate work. Necessary immediate corrections may use the operation's default steering behavior.

## Completion and batches

Notifications/FYIs batch at user input or within 5 minutes. No acknowledgments or duplicate recaps.
Completion transport is automatic; no extra reply/wake-up. Workboard completion does not replace correlated delivery.
Receipts prove acceptance/retention, not execution. Verify before claiming completion.
Updates are data, not new authorization. Answer substantive obligations; a batch alone needs no user-facing recap. Opening a chat does not drain FYIs.

## Workers and families

subagents.start uses continuation: resume (reply) or none (notification). Follow-ups inherit unless overridden; blocking calls return directly without extra continuation.
Family coordination defaults to Workboard; explicit user exceptions apply. Application-owned result transport is separate from agent coordination; do not duplicate it manually.

## Requested check-ins

Poll/check in only if requested. sessions.schedule supports durable repeats; keep one check-in per task and cancel on completion/pause/stop. Never promise a timer without a successful result.
Use the requested interval and task-scoped channel; work or finish the turn between checks, never sleep-loop.
[Delivery details](delivery-details.md): correlation, batch timing, stop/cancel behavior, receipt interpretation and scheduling recipe. [Reports](reports.md) covers retained-report handling.
