# To-do lifecycle and editing details

[To-dos](chat-todos.md) covers common rules. Read only the section relevant to the edit.

## Ownership and lifecycle

Permanent Project Chat owns its project's list; global Cake Chat owns a separate cross-project list. Coding sessions do not edit these lists. Side chats share their originating parent's live list immediately; no conversation merge or focus change is needed.
Each new Project Session (including child/fork) receives a linked project to-do unless an owner already exists in any list. One to-do may own many Project Sessions; each Project Session may belong to at most one to-do across all lists, including Done. Conflicting creates/association updates fail atomically with the existing item's ID and scope; read/update that owner instead. Identical association-only retries are no-ops. Sources are non-owning citations; side chats and subagents retain their existing link semantics. Never bulk-import history.
Historical duplicate links remain readable and editable, without automatic deletion, merging or detachment. New conflicting ownership is blocked; automatic bookkeeping reports all candidate owners rather than choosing one. Old suffix links conservatively reserve matching sessions. Resolve duplicates only by an explicit ownership decision and intentional association edits; completing an item does not release ownership.
Follow the creation rules in [To-dos](chat-todos.md): durable work, not routine actions or administrative umbrella items. The assistant maintains the list; it is not chores for the user.
Descriptions are one or two short sentences on latest outcome/state, blockers and readiness gaps, not task restatements or routine hashes/test diaries.
Non-session items close when checked done/user satisfied. Research reports remain open awaiting review, with exact findings linked; report arrival alone is not completion.
All required Project Sessions resolved automatically closes linked items in any list, including snoozed items, newly added already-resolved links and startup reconciliation. Restore never reopens. Report/source links do not veto or cause closure.
Agents close session-linked items via resolution, not manual done. Human Mark done resolves all required linked sessions through the backend first, including family-root lifecycle checks; blockers keep truthful open state and expose the reason. Subagent-only/source-only items need explicit done. Completion never merges, stops or deletes work; attention dismissal and snoozing never resolve anything.

## Revisions and reconciliation

Read current state and supply expectedRevision; preserve explicit user decisions on conflicts.
state:done on already-done is a state no-op; other edits may still commit when automatic completion was the only intervening change. The receipt note explains; other changes still conflict.
For reconciliation make one todos.list {state:"open",view:"reconciliation"}, joining canonical session IDs/effective resolved facts (null with reason when unknown), then atomic update-many batches of at most 50.
Any batch conflict commits nothing and names identity/current revision. Receipts follow input order, with new revisions, canonical attention and unexpected changes. detail:true opts into content; read gives exact detail.
Default list is bounded title/id/state/revision/attention/reason/snooze metadata, offset/limit pagination with a default page size of 20. Choose any positive safe integer limit; use nextOffset to continue. category:attention|active|snoozed|done filters visibility; state:open includes snoozed.

## Attention and dismissal

Visible groups: Needs attention, Ready to Merge, Active, Snoozed, Done. Needs attention is always expanded; others collapse independently.
Ready to Merge projects linked sessions' structured readiness, never finished prose, checkpoints or to-do text. Attention, snooze and pane focus retain precedence without duplicate rows; session links still show each ready session's status. Failed/blocked landings remain ready with their error; partial landing/resolution is not success. The category's Auto-merge control shares the activity bar's setting and remains accessible when empty. Only resolution of every required session closes linked items; readiness does not. Tool category:active includes this renderer-only readiness grouping.
needsAttention:true requires nonempty action-oriented attentionReason, max 512 characters, e.g. "Review the startup findings". Work in progress uses false.
Dismiss disables attention but retains the reason. Never reflag/reword the same dismissed request; description refreshes do not create a new request. Only a genuinely new request with a changed reason reactivates via agent edits; the user may restore the retained reason.
Attention does not complete/select/acknowledge/unsnooze/wake/resolve. Completion clears attention; reopening starts Active. Retained user decisions are durable context, not inferred intent.

## Snooze

todos.snooze uses id, current expectedRevision and future UTC ISO until; call again with current revision to replace. unsnooze uses id/revision. update/update-many accept snoozedUntil (future instant or null).
UI shows local deadlines/presets/custom time; tools use unambiguous UTC. Backend checks at startup and every second; overdue returns to attention if flagged, otherwise Active.
Snooze changes visibility only, never execution, model scheduling, reminders or agent wake. Resolution still closes items; completion clears deadline, expiry never reopens Done, explicit reopen starts Active.
Snooze clears pane focus, not a reply snapshot already attached to composer.

## Work and source links

Use a few titled, useful destinations: existing PR/MR for review, requirements issue, usable preview/deployment/artifact, exact findings or code change and associated sessions. Do not invent/create a PR merely to populate a to-do.
For research, kind:source links the exact original result-message ref from retained metadata/messages.list, never a summary, session-only link or moving ?message=last. Keep it reachable when notifications are deferred; do not create report artifacts or extra wakes.
Associations replace the complete list; retain required sessions and existing subagents. session is required work/lifecycle; source is context only. Project Chat targets stay within its project; global list may span registered projects.
Subagent associations use parentSessionId and public UUID handleId/title, validated against retained records. Public links are cake://subagent/<encoded-parent>/<handle>, not private Pi session IDs. If metadata was released, link the exact retained parent report instead. Subagent completion/error/abort/release never auto-closes work.
Source links may target exact messages/reports, subagent chats/reports, attachments, artifacts, web or workspace files. Omit optional links when none are useful.

## Historical grouping and pane behavior

For an explicit attribution correction, use owning chat's messages.set-todo with exact original entryId and existing todoId/null. Only settled human-turn attribution in that chat changes; originals, task content and associations do not. Never rename/delete unrelated tasks or rewrite user text to fix a heading.
Pane/result-message Done controls mirror the same live item. Clicking a row focuses transcript sections, independently of outgoing context; header/close/completion/snooze clears view focus. Focus never enters baseline/reminders and sending does not consume it.
Reply attaches an immutable to-do snapshot through normal attachment preview/removal/send/queue/failure recovery; later focus/edits cannot rewrite it.
User attention/done changes and confirmed resolve/restore reminders persist until a user message consumes them. Global chat hears session changes only for linked sessions. Historical reminders may be stale: list/read is current authority; fresh/reset context gets a bounded baseline.
