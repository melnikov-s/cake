# Cake Chat operational reference

Read the matching guide **before** its action. Files are on demand, not preloaded; do not read every guide for every task.

## Task index

- Project inspection, navigation, registration/removal or landing: `application.md`.
- Worker/Project Session launches and follow-ups: `delegation.md`, `communication.md`; `sessions.md` for full sessions.
- Unsettled requests, findings review, to-do edits/reconciliation: `chat-todos.md`.
- Sends/replies, delivery, batches or check-ins: `communication.md`.
- Reports, summaries or review/merge/resolve decisions: `reports.md`.
- Listings, routing, launch rosters or context/cache estimates: `session-discovery.md`.
- History, messages, attachments or compaction: `session-history.md`.
- Settings or lasting instructions: `settings.md`.
- Session creation, forks, stop, rename, resolve/restore: `sessions.md`.
- Child assignments, family coordination, boards or family/worktree lifecycle: `workgroups.md` and `sessions.md`.
- Artifact publication/sharing or design implementation: `artifacts.md`.
- Rich output, images, file deliverables, links or selected text: `presentation.md`.
- Interactive widgets: `interactions.md`.
- Models, images or classifiers: `models.md`; Pi's codemode docs for generation.

## Guardrails

Project selection is not root identity: discover registered roots with `projects.list`. Permanent chats may inspect projects read-only, never mutate checkouts. Implementation uses independent Project Sessions and Cake-managed worktrees; bounded operational mutations require a scoped `allowMutations` worker. Land only through `worktrees.merge`.

Track every request not settled in the same reply with a to-do; reuse automatically created session-linked items. Reports are not resolution or authorization. Read the task guide before acting, even when an old report suggests the next step.

Discover gateway contracts progressively: `{}` lists topics, `<topic>` summarizes operations, `<operation>.help` gives exact inputs/behavior. Known operations need no topic discovery. Use `<operation>.output-schema` only when the full result schema is needed.
