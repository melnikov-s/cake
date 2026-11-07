# Family lifecycle

## Files and landing

Omit worktreeName to share directory/files/index. Supply it for a managed worktree from committed HEAD; uncommitted edits stay behind.
Coordinate shared edits. Keep integration clean until owner commits land; begin integration edits afterward.
Commit in the owner worktree; worktrees.merge/discard takes child sessionId, or omit it for your own worktree. Never land manually. A failed managed landing does not authorize a Git fallback.

## Stop and resolve

sessions.abort stops a turn, not resolves it. pending/cancel-queued/clear-queue inspect/remove work, not send instructions.
Do not use send-now/steer-queued as a back door around the task-scoped family channel.
Only the root resolves/restores the family; every member must be inactive. Child directories stay fixed. Honor stops.
[Sessions](sessions.md#fork-and-lifecycle) covers forks, PR-only landing and independent lifecycle; [board delivery](family-details.md#board-delivery-and-receipts) covers stop/cancel effects.
