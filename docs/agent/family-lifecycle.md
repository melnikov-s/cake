# Family worktrees and lifecycle

Read before sharing checkouts, landing child work, stopping or resolving a family. Start with `workgroups.md`; read `sessions.md` and the relevant operation help for lifecycle contracts.

Omit `worktreeName` to let a child inherit this exact Working Directory and share mutable files, uncommitted changes, and Git index state; coordinate concurrent edits on the board. Supply `worktreeName` to create a Cake-managed worktree branched from this session's current checkout. A new worktree includes the current committed HEAD; uncommitted edits remain in this session's checkout and do not carry into the child. Never create an unrelated worktree base manually. Children can recursively create children under these same rules.

Keep an integration landing checkout clean while isolated implementations run. Use Cake's serialized landing operations; begin integration edits after the required owner commits have landed. Use `worktrees.merge` and `worktrees.discard` with the child's `sessionId` for isolated child worktrees; never merge a child's branch by hand. To land your own Managed Worktree, call `worktrees.merge` without a sessionId; never merge into the target checkout by hand.

Stopping and queue inspection are lifecycle controls, not communication transports. `sessions.abort` stops an active turn without resolving or deleting the member. `sessions.pending` inspects a queue; `sessions.cancel-queued` or `sessions.clear-queue` can remove pending inputs. Do not use `sessions.steer-queued` or `sessions.send-now` to deliver family instructions outside the board.

Only the family root owns resolution; all descendants inherit it and cannot be resolved or restored independently. Only the root can resolve or restore the whole family, and resolution requires every member to be inactive. A child's Cake Working Directory is fixed; it cannot detach or relocate.
