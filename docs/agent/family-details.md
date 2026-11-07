# Family launch and delivery details

[Delegate](family-delegation.md) and [coordinate](family-coordination.md) cover the normal path. These details are only needed for retries, changing decisions or delivery diagnosis.

## Launch and retry

sessions.create-child establishes/extends the family and its automatic Workboard; independent sessions cannot join through these tools. No board-create/join step is available.
Cake reserves child identity, persists the addressed assignment and then admits the first turn. Startup includes the full assignment once, operating basics, exact addressed board calls and reserved result mode.
accepted means durable intake, not completed work. already-admitted reports retained journal state (active/blocked/complete/failed/stopped) without restarting. failed names the stage and retains a retryable reservation.
Retry with returned requestId and unchanged assignment; a fresh ID creates another child. Before admission, a crash/failure can leave a reservation awaiting deliberate retry; startup does not silently activate it. After admission, normal recovery honors stops/cancellation.
Initial child-<canonical-id> topics are application-owned handoff identities. Use separate topics for later coordination; no second assignment append/wake.
Keep optional capabilities behind task guides; do not assign children a guidance-discovery loop.

## Decisions and selective reads

Use roster-provided canonical IDs/discovered suffixes, not titles. audiences control relevance/notification, not private visibility.
Use stable topics; supersedes lists earlier sequences in that topic and includes affected owners. Targeted corrections supersede only for recipients; current means unsuperseded, never agreement/verification.
boards.current/read-new return bounded descriptions; read selected bodies (at most ten). nextAfter becomes after; omit after for refresh. Deferred bodies stay unread.
Startup supplies the initial assignment; check live context before dependent work, after compaction and before concluding, rather than rereading it just to start.

## Board delivery and receipts

Each post routes to explicit audience and unique root, excluding author. Broadcasts do not wake all members.
assignment/blocker carries necessary dependent work; routine/completion joins passive pending batches, never steering unrelated work. Up to twenty source sequences coalesce per recipient.
Necessary delivery is durable idle intake or non-disruptive active-context intake at Pi-supported boundaries. Board content cannot authorize unrelated work; no acknowledgment is required.
append returns scheduledRecipients and existing deliveries. entry-receipts exposes per-recipient delivery status independently of body-read intake timestamps; session-receipts also prove intake, not understanding.
pending = scheduled; deferred = passive reminder waiting; admitted = durable queue intake; notified = context admission; consumed = input-consumption/settlement evidence. Canceled/failed include explicit issues. None proves task execution/completion.
Reuse stable requestId for retries. Durable input/canceled IDs and startup outbox reconciliation avoid replay; do not create extra "please read" posts or completion wakes.

## Stop and completion

Explicit abort pauses board delivery and cancels unadmitted batches. A later real user input enables future posts after accounting for posts made while stopped; canceled batches never restart.
Already-staged canceled reminders are filtered without deleting Pi history. Explicit pause/off and stopped/blocked recovery retain authority. Resolution cancels pending delivery; restore does not replay it.
Board completion and correlated result delivery are separate; [delivery details](delivery-details.md) explains the latter. No second continuation grant/budget or automatic board acknowledgment exists.
