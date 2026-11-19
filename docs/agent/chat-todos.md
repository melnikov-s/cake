# To-dos

## Track and close

Track durable ongoing building, multi-step research and discussions/decisions to revisit. One to-do per outcome: carry todoId through sessions.fork, subagents.start and sessions.create for investigation, implementation and review; never create phase items. Reuse existing/session-created items. No new to-dos for routine one-shot actions (merge approved work, open websites, navigate, direct answers/lookups), even with multiple tools, delegation, verification or blockers. Update underlying tasks for blockers, not administrative umbrella items. Attribution may be null; never create just to attribute turns. Assistant-maintained, not user chores. Do not bulk-import history.
Omitted todoId preserves normal launch behavior. References must name an existing open task in the caller’s allowed project/list. Project Session-local launches use session.create; subagents.run/parallel also accept todoId.
Titles are short task names, at most 80 characters. Create/update reject longer titles without truncation. Omit title when editing other fields on legacy long-title items.
Session-linked items close through session resolution, not manual agent done. Human Mark done resolves all required linked sessions through the backend first; blockers remain visible and the item stays open. Other items close when checked complete/user satisfied. Research stays open awaiting review; link exact findings. Restore reopens session-linked Done, except Human Done. Standalone agent completion is preserved. Attention dismissal, hiding and snoozing never resolve work.
Sources and subagents are supporting evidence, not required Project Sessions. Subagent-only items require explicit done; mixed items follow all required Project Sessions resolved. `remainingWork` records context but cannot veto session-linked completion: all required sessions resolved means Done. Link required follow-up sessions before resolving current work. Standalone agent completion requires clearing `remainingWork` with `null`. Human Mark done remains explicit outcome completion, subject to required-session blockers. Reports or merges never authorize resolving sessions.

## Latest update

Latest update is the single reader-facing snapshot beneath the title. Use the existing `description` field. Leave it empty if there is nothing useful to say yet. Replace the snapshot rather than appending when meaningful progress or evidence, a blocker or decision, or the next step changes.

Ask what happened so far that matters now, what is happening or just changed, and what still needs to happen. These are prompts, not headings or required fields. Use plain language: ideally one or two sentences, no more than three. Omit anything that doesn’t orient the reader. Don’t repeat the title, narrate when the item will close, hedge with administrative filler, or paste history, raw task/session IDs, commit hashes or test inventories. Keep details in linked sessions or reports with meaningful link titles.

Example: “The report-card fix passed review. We just need to verify that the cards show the right source names.”

## Edit and associate

Read current revision before edits; preserve user decisions on conflict. Associations replace the whole list: retain required sessions and supporting subagent evidence. Sources do not affect closure. Use public worker handles, never private Pi IDs.
needsAttention requires an action-oriented attentionReason for an explicit human request. Routine report arrival never flags attention; results remain in the quiet inbox/digest unless linked to an already flagged request. Use a stable attentionRequestId for an explicit request, reused on retries/rewording; a genuinely different request may share the same reason. Do not change identity to revive a dismissed request; only a new request reflags.
snooze/unsnooze changes visibility only: id, expectedRevision, future UTC until. No work pause or agent wake.
Reconcile with todos.list {state:"open",view:"reconciliation"}, then atomic update-many batches of at most 50. No per-session history reads.
Side chats share the parent's list. messages.set-todo corrects requested historical attribution only; never rewrite transcript text.

## Historical consolidation

Existing `todos.update-many` supports an explicit, revision-checked transfer of required session associations between tasks **in the same list**, atomically validating the final ownership. Preserve every findings/report/source link and choose the outcome owner explicitly; do not silently consolidate history. Supporting subagent/source links may be retained on both items. After transfer, the old item may be annotated with the outcome link and completed when legitimately satisfied; no findings need deletion. There is no dedicated consolidation command or atomic cross-list transfer. This feature does not migrate historical duplicates automatically.

[To-do details](todo-details.md): list ownership, attention/dismissal, snooze expiry, exact source links and atomic revisions. [Grouping and pane behavior](todo-pane.md): attribution corrections and pane/reply behavior.
