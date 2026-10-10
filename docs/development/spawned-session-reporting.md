# Spawned Project Session result reporting

## Scope and authority

Automatic reporting applies only to:

- A Session Family child's initial assignment, addressed to its actual immediate parent.
- An independent Project Session created by the permanent Cake Chat coordinator through
  `sessions.create`, addressed back to Cake Chat.

Ordinary Project `session.create`, manually created sessions, saved drafts, and forks do not
acquire a report-to-creator obligation. Independence and family resolution rules do not change.
No new initial-prompt or system-prompt reminder is installed. Existing family guidance remains.

Pi owns the agent run and both transcripts. Cake owns requester provenance, correlated admission,
outcome delivery intent, and runtime lifetime. The existing `SessionFamilyStorage` response journal
and delivery worker now also support the coordinator-origin case. Version 6 adds persisted
`spawnedSessions` associations; versions 1–5 migrate with no inferred requester associations.
The small pending report payload is an outbox intent, deleted after the recipient transcript proves
receipt—not a second transcript or a permanent copy of the source answer.

Cake Chat creation uses the same backend independent-session admission as `session.create`.
Caller identity is supplied by the runtime composition, not model arguments or renderer selection.
The initial assignment carries ordinary cross-session correlation metadata, not a reminder.

## Completion evidence

A successful runtime Promise or an idle renderer projection alone does not prove completion.
The Pi adapter captures the **final assistant message of the run that consumed the tracked input**
at `agent_settled`. It does not consult a historical snapshot tail. Cake forwards a successful,
substantive final answer automatically. Empty output, tool-use tails, errors, cancellation, and
acknowledgment-only answers are not successful handoffs.

An automatic final answer is labeled `result`, not task success. Task semantics cannot be determined
reliably from Pi's stop reason. A worker can declare `completed`, `blocked`, or `failed` through
`sessions.reply`'s optional `outcome` field; otherwise its final text is forwarded with an undeclared
task outcome. Automatic report text is bounded to 100,000 characters; the original remains in Pi. This does not require a hand-written assignment instruction or reporting
reminder. An explicit terminal report is staged until the consumed turn settles. Abort or runtime
failure overrides an earlier staged success. Missing output produces a factual stopped-without-result
notice; failures include available diagnostics. Interrupted work is never silently called completed.

Workers spawned by Cake Chat can use `sessions.reply` without knowing the coordinator's synthetic
ID. Substantive initial-assignment replies (or informational sends to that creator) satisfy the same
outbox intent as the automatic answer; repeating the final answer does not produce another report.
An implicit reply to an already-delivered initial result returns `already-reported`; use an explicit
new thread/request or `sessions.send` for subsequent unrelated coordination.
Explicit `sessions.send` to Cake Chat resolves a `cake-chat` destination rather than looking in the
Project Session catalog. Ordinary Project-to-independent-Project coordination remains unchanged.

## Delivery, wake-up, and recovery

Family parents and Cake Chat share one receipt/retry policy:

1. Use a stable message ID derived from the accepted source turn.
2. Check the recipient transcript, existing correlated replies, its queue, and its active delivery
   turn before another attempt.
3. Prompt an idle recipient or follow up behind active work; never steer a completion report.
4. Mark the handoff only when the recipient transcript proves receipt. Generated failure/cancellation
   notices request no response. Informational results also use `expectsResponse: false`.

Family replies keep ordinary immediate/queued coordination delivery, but queue acceptance no longer
confirms a result. The worker checks the parent's durable receipt, retains substantive reply payloads
for queue-loss recovery, and distinguishes a later source error/cancellation from an early reply.
Later explicit coordinator exchanges retain correlated routing without reopening the initial automatic
reporting obligation.

The permanent coordinator has one application-scoped lease in the existing Pi runtime `RcMap`
after its first assembly. Closing its pane does not prevent a worker report from waking it.
Application shutdown still closes that runtime normally. Project runtimes retain their prior scoped
lifetimes.

Delivery failures remain in the same durable journal and retry. Startup marks accepted-but-unsettled
process-local work interrupted, not successful; this does not rerun the worker. It also covers a crash
between recording the requester and accepting the initial input. A confirmed stop notice closes that
handoff without marking a substantive report delivered, so subsequent startups do not repeat it.
A persisted recipient receipt prevents replay even if the process stopped before updating the journal.

## Limitations

- After a backend restart, delivery waits until normal Cake Chat initialization supplies its toolset
  and assembles its runtime. A headless backend with no initialized coordinator keeps the pending
  report; it does not invent a toolset, provider configuration, or renderer binding.
- Existing independent sessions (including the reported research reproduction) are not retroactively
  assigned a creator. No transcript migration or worker restart is performed.
- `result` is evidence of a final answer, not semantic proof that the assignment succeeded. Explicit
  outcome declarations distinguish task completion, blockers, and failure. The substantive-output
  filter is deliberately small: successful stop, at least 20 trimmed characters, and no bare
  acknowledgment. It cannot judge arbitrary natural-language report quality.
- The durable journal and Pi transcript are not one atomic transaction. Stable IDs, live queue/turn
  checks, and recipient transcript receipts cover retries and process restarts under the existing
  one-backend ownership model. This is not a distributed exactly-once protocol or a power-loss guarantee.

## Focused verification

`tests/app/domain/spawnedSessionReporting.test.ts` exercises real creation, admission, settlement,
persistence and delivery policy with controlled external Pi/renderer/storage boundaries. It covers
eligible origins, negative creation paths, idle/busy coordinator wake-up, ID-free replies, declared
outcomes, duplicate passes, startup failures, interruption, missing output, and recovered receipts.
Pi result capture and permanent coordinator lifetime have focused service regressions. Existing
family response and lifecycle suites remain part of verification.
