# Project Sessions

Read before creating, forking or changing session lifecycle. Before messaging/delegating, also read `communication.md`; before listing/routing, read `session-discovery.md`. For family work, read `workgroups.md` before assignment, coordination, board use or family/worktree lifecycle.

## Create the right session

`cake subagents` creates private bounded workers, not full Project Sessions. Use it only when the user explicitly asks for subagents, delegation or parallel agent work; never substitute it for a requested child/related/Session Family session.

From a Project Session, create an independent session with singular `{"command":"session.create","input":{"name":"...","initialPrompt":"..."}}`. Include `worktreeName` for a Cake-managed worktree; omit it to use the Project root. Cake Chat/global application control uses plural `sessions.create` with an explicit project. Permanent chats create independent sessions, never family children.

Create a family child with `{"command":"sessions.create-child","input":{"title":"...","assignment":{"description":"...","body":"Substantive task and board result requirements..."}}}`. Both title and assignment are required. Cake persists the addressed Workboard assignment before the first child turn; bootstrap-only initialPrompt calls fail validation. Inspect launch status: accepted is intake, not completion. Retry failures with the returned requestId and unchanged assignment. Children can recursively create children.

For a child, omit `worktreeName` to share the caller's exact Working Directory, mutable files and Git index; supply it for a managed worktree branched from the caller's committed HEAD. Uncommitted edits do not carry over. Never run `git worktree add` as a substitute or rebind an already-started Project Session.

## Fork and lifecycle

Continue the calling conversation with `{"command":"session.fork","input":{"prompt":"...","resolveSource":true}}`. Omit `entryId` to fork through the latest settled message; provide it to branch from that transcript entry.

Stop an active turn with `{"command":"sessions.abort","input":{"sessionId":"..."}}`; this does not resolve/delete it. Rename a target with `sessions.rename` and `sessionId`/`title`, or the caller with singular `session.rename`.

Only the family root resolves/restores the family, with every member inactive. Descendants inherit resolution and cannot resolve/restore independently. A child's Working Directory is fixed. Resolution requires no acknowledgment exchange.

Use Cake-managed worktrees and serialized landing. To land your own managed worktree, call `worktrees.merge` without sessionId; for a child's isolated worktree, pass its sessionId to `worktrees.merge`/`worktrees.discard`. Commit in the owning worktree first. Never land by hand in the target checkout; relay the confirmed outcome and next step. A failed landing is not permission for manual Git fallback.

## Messaging Cake Chat

For global Cake Chat to Project Chat routing, use the canonical `projectChatId` from `projects.list`/`projects.info`; read `session-discovery.md` for the direct path, not source grep or manual hashing.

Cake Chat is not a Project Session and has no session ID. From a Project Session, omit `sessionId` in `sessions.send`, for example `{"command":"sessions.send","input":{"text":"...","resultDelivery":"reply"}}`. `delivery`, `resultDelivery`, `threadId` and `replyToMessageId` mean the same as in `sessions.reply`. Sender label `cake-chat` is not a target reference. Cake Chat must supply a target Project Session's sessionId; it cannot message itself.

When Cake Chat assigned your work, lead the final answer with a one-line outcome. Contact it separately only for a blocker/user decision: `sessions.reply` with `outcome: "blocked"`, or `sessions.send` without sessionId and with `resultDelivery: "reply"`. Report completion once; application-owned transport needs no manual duplicate.

## Other actions

Read `settings.md` before settings/instruction changes; never edit settings files. Read `models.md` before model selection. Omit model overrides unless explicitly requested; strings are preset names, never raw model IDs. Use `<operation>.help` for unfamiliar contracts, not guessed arguments.
