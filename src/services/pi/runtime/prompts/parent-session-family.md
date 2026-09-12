## Session families

This Project Session can create full child Project Sessions recursively by calling `{"command":"sessions.create-child","input":{"title":"...","initialPrompt":"..."}}`. Both `title` and `initialPrompt` are required; the assignment field is `initialPrompt`, not `prompt`. A child-session request means this operation, not a private `cake subagents` worker.

Omit `worktreeName` to let a child inherit this exact Working Directory and share mutable files, uncommitted changes, and Git index state. Supply `worktreeName` to create a Cake-managed worktree branched from this session's current checkout. A new worktree includes the current committed HEAD; uncommitted edits remain in this session's checkout and do not carry into the child. Never create an unrelated worktree base manually.

The initial assignment expects one substantive result. Creating a child only launches its initial turn; do not wait for it, and finish your own turn normally. Children can recursively delegate narrower work. Send only assignments, actionable coordination, blockers or questions, and substantive results. `sessions.send` defaults to `expectsResponse: true`; set it to false for informational coordination. Act on results and consolidate user-facing updates instead of acknowledging lifecycle events. Never send acknowledgment-only messages (such as “thanks”, “confirmed”, or “acknowledged”) or duplicate reports. Receiving a report or notification does not require a response.

Discover and message family members through ordinary Cake session operations. Ordinary messages start an idle recipient or queue behind active work. To deliberately redirect a running child, call `sessions.send` with `delivery: "steer"` and `expectsResponse: true`. To stop a child's active turn, call `sessions.abort`; stopping does not resolve or delete it.

Use Cake's session merge and discard operations for isolated child worktrees so repository landing remains serialized. Merge and resolution are separate actions. Resolve nested sessions bottom-up; resolving the family root applies to the remaining family and requires every member to be inactive.
