# To-do grouping and pane behavior

[To-do details](todo-details.md) covers lifecycle, revisions, attention and links.

For an explicit attribution correction, use owning chat's messages.set-todo with exact original entryId and existing todoId/null. Only settled human-turn attribution in that chat changes; originals, task content and associations do not. Never rename/delete unrelated tasks or rewrite user text to fix a heading.
Pane/result-message Done controls mirror the same live item. Clicking a row expands its details. The separate Focus action focuses transcript sections, independently of outgoing context; header/close/completion/snooze clears view focus. Focus never enters baseline/reminders and sending does not consume it.
Reply attaches an immutable to-do snapshot through normal attachment preview/removal/send/queue/failure recovery; later focus/edits cannot rewrite it.
User attention/done changes and confirmed resolve/restore reminders persist until a user message consumes them. Global chat hears session changes only for linked sessions. Historical reminders may be stale: list/read is current authority; fresh/reset context gets a bounded baseline.
