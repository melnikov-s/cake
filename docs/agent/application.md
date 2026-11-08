# Application

## Identify and route

projects.list: registered roots and projectChatId. app.state: viewed context. Selection/worktree is not project-root identity; refresh live facts rather than trusting memory.
sessions.send: use projectChatId directly; no checkout inspection, hashing or AGENTS discovery. `projects.info` also supplies it before the first chat visit.
sessions.open: navigation requires the user's permission. If unavailable, offer the titled `sessions.info` deepLink; do not change that permission. [Routing and receipts](session-discovery.md).

## Register and configure

projects.add: register an existing directory, not create it. Permanent chats use a scoped mutation worker to create/clone a checkout first, then register its confirmed path. Project removal does not authorize session deletion.
projects.settings.get/update: requested project settings; iconPath names a local image (absolute or ~/ PNG/JPEG/GIF/WebP), never image bytes.
Global Cake Chat can target registered projects; Project Chat only its own. Coding sessions use singular `project.settings.*` for their project. Read first, patch requested fields, verify effective values. [Instruction-field boundaries](settings.md#dedicated-instructions).

## Land

worktrees.merge-and-resolve {sessionId}: managed landing plus persisted resolve-on-success intent. Report outcome, landed/resolved and nextStep separately; resolution-failed means Git succeeded but lifecycle completion did not. Owner conflict turns resume automatically, including resolution after success; do not poll. Unchanged already-landed work resolves without relanding. Failed/stalled/canceled landing never resolves. worktrees.merge remains merge-only. No manual Git fallback.
Commit in the owner worktree first. Awaiting-agent/stalled requires the owner to complete the requested step there, then retry Cake landing. PR-only projects use their PR workflow.
[Session/worktree lifecycle](sessions.md#fork-and-lifecycle).

Known commands run directly. For unfamiliar inputs use exact help: workers take `task`, create takes `initialPrompt`, send takes `text`, fork takes `prompt`.
