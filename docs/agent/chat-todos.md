# To-dos

## Track and close

Track durable ongoing building, multi-step research and discussions/decisions to revisit. Reuse existing/session-created items. No new to-dos for routine one-shot actions (merge approved work, open websites, navigate, direct answers/lookups), even with multiple tools, delegation, verification or blockers. Update underlying tasks for blockers, not administrative umbrella items. Attribution may be null; never create just to attribute turns. Assistant-maintained, not user chores. Do not bulk-import history.
Titles are short task names, at most 80 characters; put details in description. Create/update reject longer titles without truncation. Omit title when editing other fields on legacy long-title items. Descriptions give a short latest outcome, blockers and verification gaps. Keep provenance in links, not routine commit/test bookkeeping.
Agents close session-linked items through session resolution, not manual done. Human Mark done resolves all required linked sessions through the backend first; blockers remain visible and the item stays open. Other items close when checked complete/user satisfied. Research stays open awaiting review; link exact findings. Restore never reopens items. Attention dismissal, hiding and snoozing never resolve work.
Sources do not affect closure. Subagent-only items require explicit done; mixed items follow all required Project Sessions resolved.

## Edit and associate

Read current revision before edits; preserve user decisions on conflict. Associations replace the whole list: retain required sessions/subagents. Sources do not affect closure. Use public worker handles, never private Pi IDs.
needsAttention requires an action-oriented attentionReason. Do not revive/reword a dismissed request; only a new request reflags.
snooze/unsnooze changes visibility only: id, expectedRevision, future UTC until. No work pause or agent wake.
Reconcile with todos.list {state:"open",view:"reconciliation"}, then atomic update-many. No per-session history reads.
Side chats share the parent's list. messages.set-todo corrects requested historical attribution only; never rewrite transcript text.

[To-do details](todo-details.md): list ownership, attention/dismissal, snooze expiry, exact source links, atomic revisions, grouping corrections and pane/reply behavior.
