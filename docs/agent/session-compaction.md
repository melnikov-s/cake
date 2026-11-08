# Explicit session compaction

Only on user request. Use sessions.compact for one target, sessions.compact-batch for up to 100; instructions is optional.
Project Chat/Project Sessions stay in their project; authorized global Cake Chat may span projects. context.compact still applies to the invoking conversation.

## Outcomes and lifetime

Results preserve input order: compacted = Pi completed/persisted; unchanged = already compacted/too small; busy/invalid/unauthorized/unavailable/failed explain non-completion.
Batch continues after failures; aliases canonicalize/deduplicate and duplicateOf points to the first zero-based result. Inspect every outcome.
Busy targets are not aborted or queued. Resolved history can work if its checkout exists; drafts/retired or missing worktrees are unavailable, never restored implicitly.
Started compaction retains runtime ownership until Pi settles even after caller disconnect. No durable request replay/automatic retry. New history can be compacted on another explicit request.
sessions.queue-command is a separate window-scoped queued workflow, unavailable in permanent chats; admission is not compaction completion.

## Tool-only continuation

sessions.tool-compact uses /toolcompact without generating a summary. It replays human input and assistant text through the latest completed assistant response on the current branch.
Tool calls/results, reasoning, injected reminders and coordination are omitted from the continuation. Session identity and original inspectable tree/history remain intact (sessions.history/tree/compactions).
compacted means persistence, Pi navigation and snapshot publication completed, not queue intake. Missing completed responses/navigation errors fail.
Same scope/checkout/busy rules apply. Repeated explicit calls create another branch; no automatic retry/compaction.

## To-do-associated request

For "compact sessions associated with these completed to-dos", inspect exact item state/associations with todos.list/read. Collect session associations and session IDs in cake://session source/message/report links; call compact-batch.
Report items without sessions and every busy/failed/unavailable target. Done never triggers compaction. Human Mark done resolves required linked sessions first; agent to-do edits do not. Do not change to-do state, resolve work or compact automatically merely because an item is done.
