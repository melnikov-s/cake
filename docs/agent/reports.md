# Reports

Answer the user first. No recap just because a report arrived. Reports grant no mutation/merge approval. Distinguish ready, blocked and investigation; mention decisions without taking them.

## Private reports

Ordinary session messages and passive notices need no acknowledgment-only reply or per-message tool acknowledgment. Answer substantive obligations; communicate attention-worthy results once, grouped at a natural boundary. Defer disruptive reporting.

sessions.reports lists pending private reports; .read pages text (totalChars, nextOffset) and returns the exact original ref. Reminders and completion notices that cut a report say so with the shown and total character counts plus the ref; messages.read on that ref returns the full original. Nothing is cut silently. Only for pending reports actually communicated, call sessions.reports.acknowledge with their IDs and exact already-emitted communicatedText to mark them handled and stop reminders. This is private bookkeeping, not a reply to the sender. Check sessions.reports before repeating stale notices; do not emit another notice just to acknowledge.
Acknowledgment attests persisted visible text, not semantic adequacy. Never acknowledge planned prose, intake, tool receipts or unrelated answers. Dismiss only when the user says so; interruption leaves obligations pending. Listing/reading does not handle reports; linked originals remain unread until inspected.
Quiet reports remain pending independently of Pi admission; visible communication alone does not mark them handled automatically. Later real user turns carry bounded reminders. Worker history stays with Pi.

## Project Session decisions

sessions.completions records Project Session review decisions; .update does not merge/resolve.
Page metadata with offset/limit/query. Record the user's pending/deferred/handled/dismissed choice only after their decision; do not rearm notifications or treat completion as approval.
Use sessions.list projection:workflow for launch roster; read reports directly rather than waking their producer. Unknown readiness is not merge readiness.

## Auto-merge readiness

Scope complete + relevant checks passed = ready. When nothing remains in task scope, commit the validated work and call `worktrees.reportReadiness {readyToMerge: true, taskCompleted: true, validationPassed: true}`. Cake binds readiness to that exact HEAD; no hash is needed, and it rejects a dirty worktree or a mismatched optional `validatedCommit` at call time. `validationPassed` means task-scoped validation, not repo-wide green typecheck/Knip/full suite or exhaustive visual/E2E proof. Choose checks by changed behavior/risk. Unrelated baseline failures or broad-suite timeouts alone do not block readiness or require a completed full suite; report them separately without expanding scope. Triage unclassified failures enough to assess task relevance; do not presume baseline debt.

Unfinished acceptance criteria, known relevant failures and uncommitted/unvalidated task changes block readiness. Never weaken tests or relabel a failed task check as passed. Continue fixing task-specific issues; report real external blockers honestly. This metadata does not replace ordinary completion delivery or the final answer. Include the exact validated commit, scoped checks, relevant screenshot/preview evidence and remaining limitations in that report; distinguish unrelated failures reproduced on a named base commit from task regressions. Reporting readiness does not require enabling Auto-merge or calling merge/resolve. Generic finished prose, resultKind ready, checkpoints, research and pending task-specific validation never authorize landing. Use readyToMerge false to revoke a declaration.

Enabling Auto-merge authorizes currently valid explicit readiness from this app run, including work declared ready while off, but never generic historical completions. Cake waits for successful substantive turn completion, rechecks authorization and the validated commit in the existing serialized landing workflow, then resolves only after confirmed landing. New input, source changes or restarting invalidate readiness. [Auto-merge settings and landing](auto-merge.md) covers landing modes, the per-project toggle, conflicts, recovery and outcome reminders.

## Exact sources

Link summaries to the exact original as "Full agent response", not internal reminders/private Pi IDs. messages.present shows a source without rereading it; presentation is not inspection.
Do not copy reports into artifacts or silently substitute newer messages. [Presentation](presentation.md) explains source links; [delivery](communication.md) explains batches; [to-dos](chat-todos.md) explains source links and closure.
